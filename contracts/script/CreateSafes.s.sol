// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
    function proxyCreationCode() external view returns (bytes memory);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
    function VERSION() external view returns (string memory);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
}

/// @notice Safe 1개의 생성 입력. name은 config 섹션 이름(governance, ops, recovery, treasury, minter).
struct SafeSpec {
    string name;
    address[] owners;
    uint256 threshold;
    /// @dev 6장 테스트넷 정족수의 하한. 이보다 낮은 정족수는 거부한다.
    uint256 minThreshold;
}

struct SafesConfig {
    uint256 expectedChainId;
    address factory;
    address singleton;
    address fallbackHandler;
    uint256 saltNonce;
    SafeSpec[5] specs;
    address[] forbidden;
}

/// @notice Sepolia 등 실제 체인에 거버넌스·운영·회수·금고·발행 Safe 5개를 만든다 (design.md 6장, 13장 6단계).
///         정식 Safe v1.4.1 SafeProxyFactory로 SafeL2 프록시를 만들고, 만든 뒤 소유자·정족수·모듈·가드·
///         폴백 핸들러를 온체인에서 검증한다. 같은 입력이면 같은 주소가 나오므로 이미 있는 Safe는 다시 만들지 않는다.
///
///         배포자 EOA는 가스만 낸다. 배포자와 봇은 어떤 Safe의 서명자도 될 수 없다 (6장 "배포자는 배포 후 어떤
///         역할도 갖지 않는다", "봇 키는 동결만").
///
///         사용 (contracts/에서):
///           DEPLOY_CHAIN=sepolia forge script script/CreateSafes.s.sol --rpc-url sepolia --sender <배포자>      # 시뮬레이션
///           DEPLOY_CHAIN=sepolia forge script script/CreateSafes.s.sol --rpc-url sepolia --account <키스토어> \
///             --sender <배포자> --broadcast                                                                  # 사람이 실행
///         결과는 deployments/safes-<chain>.json에 쓴다. 그 주소를 config/deploy.<chain>.toml의 [holders]에 옮긴다.
contract CreateSafes is Script {
    error InvalidSafesConfig(string reason);
    error SafeCheckFailed(string reason);

    string internal constant SAFE_VERSION = "1.4.1";
    address internal constant SENTINEL = address(0x1);
    bytes32 internal constant FALLBACK_HANDLER_SLOT = keccak256("fallback_manager.handler.address");
    bytes32 internal constant GUARD_SLOT = keccak256("guard_manager.guard.address");

    function run() external returns (address[5] memory safes) {
        string memory chain = vm.envOr("DEPLOY_CHAIN", string("sepolia"));
        SafesConfig memory cfg = load(string.concat(vm.projectRoot(), "/../config/safes.", chain, ".toml"));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        safes = create(cfg, deployer);
        vm.stopBroadcast();

        for (uint256 i = 0; i < 5; ++i) {
            verifySafe(cfg, cfg.specs[i], safes[i]);
        }
        _write(chain, cfg, safes);
    }

    // ------------------------------------------------------------------
    // 설정
    // ------------------------------------------------------------------

    function load(string memory path) public view returns (SafesConfig memory cfg) {
        string memory t = vm.readFile(path);
        cfg.expectedChainId = vm.parseTomlUint(t, ".checks.expected_chain_id");
        cfg.factory = vm.parseTomlAddress(t, ".safe.factory");
        cfg.singleton = vm.parseTomlAddress(t, ".safe.singleton");
        cfg.fallbackHandler = vm.parseTomlAddress(t, ".safe.fallback_handler");
        cfg.saltNonce = vm.parseTomlUint(t, ".safe.salt_nonce");
        string[5] memory names = ["governance", "ops", "recovery", "treasury", "minter"];
        uint256[5] memory mins = [uint256(2), 2, 2, 2, 1];
        for (uint256 i = 0; i < 5; ++i) {
            cfg.specs[i].name = names[i];
            cfg.specs[i].owners = vm.parseTomlAddressArray(t, string.concat(".", names[i], ".owners"));
            cfg.specs[i].threshold = vm.parseTomlUint(t, string.concat(".", names[i], ".threshold"));
            cfg.specs[i].minThreshold = mins[i];
        }
        string[] memory forbidden = vm.parseTomlStringArray(t, ".forbidden.addresses");
        cfg.forbidden = new address[](forbidden.length);
        for (uint256 i = 0; i < forbidden.length; ++i) {
            cfg.forbidden[i] = vm.parseAddress(forbidden[i]);
        }
    }

    function validate(SafesConfig memory cfg, address deployer) public view {
        if (cfg.expectedChainId == 0) revert InvalidSafesConfig("expected_chain_id is 0");
        if (block.chainid != cfg.expectedChainId) revert InvalidSafesConfig("chain id mismatch");
        if (cfg.factory.code.length == 0) revert InvalidSafesConfig("factory has no code");
        if (cfg.singleton.code.length == 0) revert InvalidSafesConfig("singleton has no code");
        if (cfg.fallbackHandler.code.length == 0) revert InvalidSafesConfig("fallback handler has no code");
        if (keccak256(bytes(ISafe(cfg.singleton).VERSION())) != keccak256(bytes(SAFE_VERSION))) {
            revert InvalidSafesConfig("singleton is not Safe 1.4.1");
        }
        for (uint256 i = 0; i < 5; ++i) {
            SafeSpec memory s = cfg.specs[i];
            if (s.owners.length == 0) revert InvalidSafesConfig(string.concat(s.name, ": no owners"));
            if (s.threshold < s.minThreshold) revert InvalidSafesConfig(string.concat(s.name, ": threshold below table"));
            if (s.threshold > s.owners.length) revert InvalidSafesConfig(string.concat(s.name, ": threshold > owners"));
            for (uint256 j = 0; j < s.owners.length; ++j) {
                address o = s.owners[j];
                if (o == address(0)) revert InvalidSafesConfig(string.concat(s.name, ": zero owner"));
                if (o == deployer) revert InvalidSafesConfig(string.concat(s.name, ": deployer is owner"));
                for (uint256 k = 0; k < cfg.forbidden.length; ++k) {
                    if (o == cfg.forbidden[k]) revert InvalidSafesConfig(string.concat(s.name, ": forbidden owner"));
                }
                for (uint256 k = 0; k < j; ++k) {
                    if (o == s.owners[k]) revert InvalidSafesConfig(string.concat(s.name, ": duplicate owner"));
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // 생성
    // ------------------------------------------------------------------

    function initializer(SafesConfig memory cfg, SafeSpec memory s) public pure returns (bytes memory) {
        return abi.encodeCall(
            ISafe.setup,
            (s.owners, s.threshold, address(0), "", cfg.fallbackHandler, address(0), 0, payable(address(0)))
        );
    }

    /// @dev 입력이 같아도 Safe마다 주소가 달라야 하므로 salt에 이름을 섞는다.
    function saltNonceOf(SafesConfig memory cfg, SafeSpec memory s) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(cfg.saltNonce, s.name)));
    }

    /// @notice SafeProxyFactory 1.4.1의 CREATE2 주소.
    function predict(SafesConfig memory cfg, SafeSpec memory s) public view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer(cfg, s)), saltNonceOf(cfg, s)));
        bytes memory code =
            abi.encodePacked(ISafeProxyFactory(cfg.factory).proxyCreationCode(), uint256(uint160(cfg.singleton)));
        return vm.computeCreate2Address(salt, keccak256(code), cfg.factory);
    }

    function create(SafesConfig memory cfg, address deployer) public returns (address[5] memory safes) {
        validate(cfg, deployer);
        for (uint256 i = 0; i < 5; ++i) {
            SafeSpec memory s = cfg.specs[i];
            address expected = predict(cfg, s);
            if (expected.code.length == 0) {
                address got = ISafeProxyFactory(cfg.factory).createProxyWithNonce(
                    cfg.singleton, initializer(cfg, s), saltNonceOf(cfg, s)
                );
                if (got != expected) revert SafeCheckFailed(string.concat(s.name, ": unexpected address"));
            }
            safes[i] = expected;
        }
    }

    // ------------------------------------------------------------------
    // 검증
    // ------------------------------------------------------------------

    function verifySafe(SafesConfig memory cfg, SafeSpec memory s, address safe) public view {
        if (safe.code.length == 0) revert SafeCheckFailed(string.concat(s.name, ": no code"));
        address singleton = address(uint160(uint256(vm.load(safe, bytes32(0)))));
        if (singleton != cfg.singleton) revert SafeCheckFailed(string.concat(s.name, ": wrong singleton"));
        if (keccak256(bytes(ISafe(safe).VERSION())) != keccak256(bytes(SAFE_VERSION))) {
            revert SafeCheckFailed(string.concat(s.name, ": wrong version"));
        }
        if (ISafe(safe).getThreshold() != s.threshold) revert SafeCheckFailed(string.concat(s.name, ": threshold"));
        address[] memory owners = ISafe(safe).getOwners();
        if (owners.length != s.owners.length) revert SafeCheckFailed(string.concat(s.name, ": owner count"));
        for (uint256 j = 0; j < s.owners.length; ++j) {
            if (!ISafe(safe).isOwner(s.owners[j])) revert SafeCheckFailed(string.concat(s.name, ": missing owner"));
        }
        (address[] memory modules,) = ISafe(safe).getModulesPaginated(SENTINEL, 10);
        if (modules.length != 0) revert SafeCheckFailed(string.concat(s.name, ": has modules"));
        if (vm.load(safe, GUARD_SLOT) != bytes32(0)) revert SafeCheckFailed(string.concat(s.name, ": has guard"));
        address handler = address(uint160(uint256(vm.load(safe, FALLBACK_HANDLER_SLOT))));
        if (handler != cfg.fallbackHandler) revert SafeCheckFailed(string.concat(s.name, ": fallback handler"));
    }

    // ------------------------------------------------------------------
    // 출력
    // ------------------------------------------------------------------

    function _write(string memory chain, SafesConfig memory cfg, address[5] memory safes) internal {
        string memory key = "safes";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "factory", cfg.factory);
        vm.serializeAddress(key, "singleton", cfg.singleton);
        vm.serializeAddress(key, "governance_safe", safes[0]);
        vm.serializeAddress(key, "ops_safe", safes[1]);
        vm.serializeAddress(key, "recovery_safe", safes[2]);
        vm.serializeAddress(key, "treasury_safe", safes[3]);
        string memory json = vm.serializeAddress(key, "minter", safes[4]);

        console2.log("config/deploy.<chain>.toml [holders]:");
        console2.log("governance_safe =", safes[0]);
        console2.log("ops_safe        =", safes[1]);
        console2.log("recovery_safe   =", safes[2]);
        console2.log("treasury_safe   =", safes[3]);
        console2.log("minter          =", safes[4]);
        // 시뮬레이션에서는 Safe가 아직 없으므로 기록 파일을 쓰지 않는다.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            string memory out = string.concat(vm.projectRoot(), "/../deployments/safes-", chain, ".json");
            vm.writeJson(json, out);
            console2.log("written:", out);
        } else {
            console2.log("simulation only: deployments/safes-<chain>.json not written");
        }
    }
}

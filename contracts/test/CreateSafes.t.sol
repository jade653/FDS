// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreateSafes, SafesConfig, SafeSpec, ISafe} from "../script/CreateSafes.s.sol";

/// @notice CreateSafes.s.sol 테스트. 정식 Safe v1.4.1 컨트랙트가 필요해 Sepolia 포크에서 돈다.
///         SEPOLIA_RPC_URL이 없으면 건너뛴다:
///           SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test --match-contract CreateSafesTest
contract CreateSafesTest is Test {
    CreateSafes internal script;
    string internal configPath;
    address internal deployer = makeAddr("deployer");
    address internal bot = makeAddr("bot");
    bool internal forked;

    function setUp() public {
        string memory url = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
        script = new CreateSafes();
        configPath = string.concat(vm.projectRoot(), "/../config/safes.sepolia.toml");
    }

    /// @dev 실제 서명자 대신 테스트 주소를 넣은 설정. 테스트넷처럼 Safe끼리 서명자가 겹친다.
    ///      Safe마다 배열을 따로 만든다 (메모리 배열을 공유하면 한 곳을 고칠 때 다 바뀐다).
    function _cfg() internal returns (SafesConfig memory cfg) {
        cfg = script.load(configPath);
        for (uint256 i = 0; i < 5; ++i) {
            address[] memory o = new address[](i < 4 ? 3 : 2);
            for (uint256 j = 0; j < o.length; ++j) {
                o[j] = makeAddr(string.concat("signer", vm.toString(j)));
            }
            cfg.specs[i].owners = o;
        }
        // 실행마다 새 주소가 나오도록 salt를 바꾼다 (포크 시점에 이미 같은 Safe가 있을 수 있다).
        cfg.saltNonce = uint256(keccak256(abi.encode(block.number, "test")));
        cfg.forbidden = new address[](1);
        cfg.forbidden[0] = bot;
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    // ------------------------------------------------------------------
    // 생성과 검증
    // ------------------------------------------------------------------

    function test_createsFiveVerifiedSafes() public onFork {
        SafesConfig memory cfg = _cfg();
        address[5] memory safes = script.create(cfg, deployer);
        for (uint256 i = 0; i < 5; ++i) {
            script.verifySafe(cfg, cfg.specs[i], safes[i]);
            assertEq(ISafe(safes[i]).getThreshold(), cfg.specs[i].threshold);
            assertEq(ISafe(safes[i]).getOwners().length, cfg.specs[i].owners.length);
            assertFalse(ISafe(safes[i]).isOwner(deployer));
            assertFalse(ISafe(safes[i]).isOwner(bot));
            for (uint256 j = 0; j < i; ++j) {
                assertTrue(safes[i] != safes[j], "same owners must still give distinct Safes");
            }
        }
        assertEq(ISafe(safes[0]).getThreshold(), 2);
        assertEq(ISafe(safes[4]).getThreshold(), 1);
    }

    function test_addressesMatchPrediction() public onFork {
        SafesConfig memory cfg = _cfg();
        address[5] memory safes = script.create(cfg, deployer);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(safes[i], script.predict(cfg, cfg.specs[i]));
        }
    }

    function test_secondRunReusesSafes() public onFork {
        SafesConfig memory cfg = _cfg();
        address[5] memory a = script.create(cfg, deployer);
        address[5] memory b = script.create(cfg, deployer);
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(a[i], b[i]);
        }
    }

    function test_verifyDetectsChangedThreshold() public onFork {
        SafesConfig memory cfg = _cfg();
        address[5] memory safes = script.create(cfg, deployer);
        cfg.specs[0].threshold = 3;
        vm.expectRevert(abi.encodeWithSelector(CreateSafes.SafeCheckFailed.selector, "governance: threshold"));
        script.verifySafe(cfg, cfg.specs[0], safes[0]);
    }

    function test_verifyDetectsMissingOwner() public onFork {
        SafesConfig memory cfg = _cfg();
        address[5] memory safes = script.create(cfg, deployer);
        cfg.specs[0].owners[2] = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(CreateSafes.SafeCheckFailed.selector, "governance: missing owner"));
        script.verifySafe(cfg, cfg.specs[0], safes[0]);
    }

    function test_verifyDetectsNonSafe() public onFork {
        SafesConfig memory cfg = _cfg();
        vm.expectRevert(abi.encodeWithSelector(CreateSafes.SafeCheckFailed.selector, "governance: no code"));
        script.verifySafe(cfg, cfg.specs[0], makeAddr("eoa"));
    }

    // ------------------------------------------------------------------
    // 설정 거부
    // ------------------------------------------------------------------

    function _expectInvalid(SafesConfig memory cfg, string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(CreateSafes.InvalidSafesConfig.selector, reason));
        script.validate(cfg, deployer);
    }

    function test_validConfigPasses() public onFork {
        script.validate(_cfg(), deployer);
    }

    /// @dev 저장소의 실제 설정(서명자 3명, 봇 금지)이 배포자가 서명자가 아닐 때 통과하는지.
    function test_repoConfigPasses() public onFork {
        SafesConfig memory cfg = script.load(configPath);
        script.validate(cfg, deployer);
        assertEq(cfg.forbidden.length, 1, "bot must be forbidden as a signer");
    }

    function test_rejectsZeroOwner() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.specs[0].owners[0] = address(0);
        _expectInvalid(cfg, "governance: zero owner");
    }

    function test_rejectsDeployerAsOwner() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.specs[1].owners[0] = deployer;
        _expectInvalid(cfg, "ops: deployer is owner");
    }

    function test_rejectsForbiddenOwner() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.specs[2].owners[2] = bot;
        _expectInvalid(cfg, "recovery: forbidden owner");
    }

    function test_rejectsDuplicateOwner() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.specs[3].owners[2] = cfg.specs[3].owners[0];
        _expectInvalid(cfg, "treasury: duplicate owner");
    }

    function test_rejectsThresholdBelowTable() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.specs[0].threshold = 1;
        _expectInvalid(cfg, "governance: threshold below table");
    }

    function test_rejectsZeroMinterThreshold() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.specs[4].threshold = 0;
        _expectInvalid(cfg, "minter: threshold below table");
    }

    function test_rejectsThresholdAboveOwners() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.specs[4].threshold = 3;
        _expectInvalid(cfg, "minter: threshold > owners");
    }

    function test_rejectsNoOwners() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.specs[1].owners = new address[](0);
        _expectInvalid(cfg, "ops: no owners");
    }

    function test_rejectsWrongChain() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.expectedChainId = 1;
        _expectInvalid(cfg, "chain id mismatch");
    }

    function test_rejectsFactoryWithoutCode() public onFork {
        SafesConfig memory cfg = _cfg();
        cfg.factory = makeAddr("nofactory");
        _expectInvalid(cfg, "factory has no code");
    }

    function test_rejectsWrongSingleton() public onFork {
        SafesConfig memory cfg = _cfg();
        // 폴백 핸들러는 코드가 있지만 Safe 1.4.1 싱글턴이 아니다.
        cfg.singleton = cfg.fallbackHandler;
        vm.expectRevert();
        script.validate(cfg, deployer);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployConfig, Deployment, DeployConfigLib} from "../script/lib/DeployConfig.sol";
import {DeploymentChecks} from "../script/lib/DeploymentChecks.sol";
import {StableToken} from "../src/StableToken.sol";
import {StableTokenV2} from "./mocks/StableTokenV2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @dev 내부 라이브러리 함수를 expectRevert로 검사하기 위한 외부 래퍼.
contract Verifier {
    function verify(DeployConfig memory c, Deployment memory d, bool fresh) external view {
        DeploymentChecks.verify(c, d, fresh);
    }
}

/// @notice 배포 스크립트 테스트 (design.md 12장): 배포 후 배포자에게 남은 권한이 없고 6장 표와 실제 역할이 일치하는지,
///         타임락 admin 보유자가 없고, ProxyAdmin 소유자가 타임락이며, MINTER admin이 MASTER_MINTER인지 확인한다.
///         실제 Anvil 노드에 대한 브로드캐스트 검증은 `script/anvil-deploy.sh`가 한다.
contract DeployTest is Test {
    Deploy internal script;
    Verifier internal verifier;
    DeployConfig internal c;
    Deployment internal d;
    StableToken internal t;
    TimelockController internal tl;
    address internal deployer;

    function setUp() public {
        script = new Deploy();
        verifier = new Verifier();
        c = DeployConfigLib.load(string.concat(vm.projectRoot(), "/../config/deploy.anvil.toml"));
        // 테스트에서는 스크립트 컨트랙트가 배포자 EOA 자리에 선다 (브로드캐스트 없이 호출하면 msg.sender가 스크립트다).
        deployer = address(script);
        d = script.deploy(c, deployer);
        t = StableToken(d.token);
        tl = TimelockController(payable(d.timelock));
    }

    // ------------------------------------------------------------------
    // 배포 직후 상태
    // ------------------------------------------------------------------

    function test_verificationPasses() public view {
        verifier.verify(c, d, true);
    }

    function test_deployerHasNoTokenRoles() public view {
        (bytes32[9] memory r,) = DeploymentChecks.roles(t);
        for (uint256 i = 0; i < r.length; ++i) {
            assertFalse(t.hasRole(r[i], deployer));
        }
    }

    function test_deployerNeverHadTimelockAdmin() public view {
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), deployer));
        assertFalse(tl.hasRole(tl.PROPOSER_ROLE(), deployer));
        assertFalse(tl.hasRole(tl.CANCELLER_ROLE(), deployer));
        assertTrue(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), d.timelock));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), address(0)));
        assertEq(tl.getMinDelay(), 600);
    }

    function test_proxyAdminOwnedByTimelock() public view {
        assertEq(ProxyAdmin(d.proxyAdmin).owner(), d.timelock);
    }

    function test_roleAdmins() public view {
        assertEq(t.getRoleAdmin(t.MINTER_ROLE()), t.MASTER_MINTER_ROLE());
        assertEq(t.getRoleAdmin(t.FREEZER_ROLE()), t.GUARDIAN_ROLE());
        assertEq(t.getRoleAdmin(t.WIPER_ROLE()), t.DEFAULT_ADMIN_ROLE());
    }

    function test_roleTable() public view {
        assertTrue(t.hasRole(t.DEFAULT_ADMIN_ROLE(), d.timelock));
        assertTrue(t.hasRole(t.GUARDIAN_ROLE(), c.opsSafe));
        assertTrue(t.hasRole(t.FREEZER_ROLE(), c.opsSafe));
        assertTrue(t.hasRole(t.FREEZER_ROLE(), c.bot));
        assertTrue(t.hasRole(t.UNFREEZER_ROLE(), c.opsSafe));
        assertTrue(t.hasRole(t.PAUSER_ROLE(), c.opsSafe));
        assertTrue(t.hasRole(t.RESCUER_ROLE(), c.opsSafe));
        assertTrue(t.hasRole(t.WIPER_ROLE(), c.recoverySafe));
        assertTrue(t.hasRole(t.MASTER_MINTER_ROLE(), c.treasurySafe));
        assertTrue(t.hasRole(t.MINTER_ROLE(), c.minter));
        assertEq(t.minterAllowance(c.minter), 1_000_000e6);
        assertEq(t.minFreezeAge(), 600);
    }

    function test_protectedSet() public view {
        assertTrue(t.isProtected(d.timelock));
        assertTrue(t.isProtected(d.token));
        assertTrue(t.isProtected(c.governanceSafe));
        assertTrue(t.isProtected(c.opsSafe));
        assertTrue(t.isProtected(c.recoverySafe));
        assertTrue(t.isProtected(c.treasurySafe));
        assertTrue(t.isProtected(c.minter));
        assertFalse(t.isProtected(c.bot));
    }

    function test_implementationCannotBeInitialized() public {
        vm.expectRevert();
        StableToken(d.implementation).initialize("x", "x", address(this), 0);
    }

    // ------------------------------------------------------------------
    // 배포 후 운영 경로
    // ------------------------------------------------------------------

    function _timelockExecute(address target, bytes memory data) internal {
        bytes32 salt = keccak256(data);
        vm.prank(c.governanceSafe);
        tl.schedule(target, 0, data, bytes32(0), salt, 600);
        vm.warp(block.timestamp + 600);
        // 실행자 개방: 아무나 실행할 수 있다.
        vm.prank(makeAddr("anyone"));
        tl.execute(target, 0, data, bytes32(0), salt);
    }

    function test_timelockCanGrantRoleAfterDelay() public {
        address newPauser = makeAddr("newPauser");
        bytes memory data = abi.encodeCall(IAccessControl.grantRole, (t.PAUSER_ROLE(), newPauser));
        bytes32 salt = keccak256(data);
        vm.prank(c.governanceSafe);
        tl.schedule(d.token, 0, data, bytes32(0), salt, 600);

        vm.warp(block.timestamp + 599);
        vm.expectRevert();
        tl.execute(d.token, 0, data, bytes32(0), salt);

        vm.warp(block.timestamp + 1);
        tl.execute(d.token, 0, data, bytes32(0), salt);
        assertTrue(t.hasRole(t.PAUSER_ROLE(), newPauser));
    }

    function test_onlyGovernanceCanPropose() public {
        bytes memory data = abi.encodeCall(StableToken.setMinFreezeAge, (1));
        bytes32 proposerRole = tl.PROPOSER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, c.opsSafe, proposerRole)
        );
        vm.prank(c.opsSafe);
        tl.schedule(d.token, 0, data, bytes32(0), bytes32(0), 600);
    }

    function test_upgradeThroughTimelock() public {
        StableTokenV2 v2 = new StableTokenV2();
        bytes memory data = abi.encodeCall(
            ProxyAdmin.upgradeAndCall,
            (ITransparentUpgradeableProxy(d.token), address(v2), abi.encodeCall(StableTokenV2.initializeV2, (7)))
        );
        _timelockExecute(d.proxyAdmin, data);
        assertEq(StableTokenV2(d.token).version(), 2);
        assertTrue(t.hasRole(t.FREEZER_ROLE(), c.bot));
    }

    function test_opsSafeRevokesBotWithoutTimelock() public {
        bytes32 freezer = t.FREEZER_ROLE();
        vm.prank(c.opsSafe);
        t.revokeRole(freezer, c.bot);
        assertFalse(t.hasRole(freezer, c.bot));
    }

    function test_botCanOnlyFreeze() public {
        address victim = makeAddr("victim");
        address other = makeAddr("x");
        bytes32 freezer = t.FREEZER_ROLE();
        vm.startPrank(c.bot);
        t.freeze(victim, bytes32("R1"));
        vm.expectRevert();
        t.unfreeze(victim);
        vm.expectRevert();
        t.pause();
        vm.expectRevert();
        t.freeze(c.minter, bytes32("R1")); // 보호 주소
        vm.expectRevert();
        t.grantRole(freezer, other);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // 검증기가 잘못된 상태를 잡는지 (음성 테스트)
    // ------------------------------------------------------------------

    function _expectCheck(string memory what) internal {
        vm.expectRevert(abi.encodeWithSelector(DeploymentChecks.CheckFailed.selector, what));
        verifier.verify(c, d, true);
    }

    function test_detectsDeployerLeftoverRole() public {
        bytes32 role = t.GUARDIAN_ROLE();
        vm.prank(d.timelock);
        t.grantRole(role, deployer);
        _expectCheck("deployer unexpectedly has GUARDIAN");
    }

    function test_detectsBotExtraRole() public {
        bytes32 role = t.UNFREEZER_ROLE();
        vm.prank(d.timelock);
        t.grantRole(role, c.bot);
        _expectCheck("bot unexpectedly has UNFREEZER");
    }

    function test_detectsMissingRole() public {
        bytes32 role = t.WIPER_ROLE();
        vm.prank(d.timelock);
        t.revokeRole(role, c.recoverySafe);
        _expectCheck("recovery_safe is missing WIPER");
    }

    function test_detectsProxyAdminOwnerChange() public {
        vm.prank(d.timelock);
        ProxyAdmin(d.proxyAdmin).transferOwnership(deployer);
        _expectCheck("ProxyAdmin owner is not the timelock");
    }

    function test_detectsExtraTimelockProposer() public {
        bytes32 role = tl.PROPOSER_ROLE();
        vm.prank(d.timelock);
        tl.grantRole(role, c.opsSafe);
        _expectCheck("ops_safe is timelock proposer");
    }

    function test_detectsTimelockAdminHolder() public {
        bytes32 role = tl.DEFAULT_ADMIN_ROLE();
        vm.prank(d.timelock);
        tl.grantRole(role, deployer);
        _expectCheck("deployer has timelock admin");
    }

    function test_detectsClosedExecutor() public {
        bytes32 role = tl.EXECUTOR_ROLE();
        vm.prank(d.timelock);
        tl.revokeRole(role, address(0));
        _expectCheck("executor is not open");
    }

    function test_detectsUnprotectedMinter() public {
        vm.prank(d.timelock);
        t.setProtected(c.minter, false);
        _expectCheck(string.concat("not protected: ", vm.toString(c.minter)));
    }

    function test_detectsChangedRoleAdmin() public {
        // WIPER admin을 GUARDIAN으로 바꾸면 운영 Safe가 회수 권한을 줄 수 있게 된다.
        // StableToken에는 _setRoleAdmin을 여는 함수가 없으므로 저장소를 직접 바꿔 흉내 낸다.
        bytes32 wiper = t.WIPER_ROLE();
        // AccessControl ERC-7201 슬롯: roles mapping은 슬롯 0, RoleData{members(0), adminRole(1)}
        bytes32 base = 0x02dd7bc7dec4dceedda775e58dd541e08a116c6c53815c0bd028192f7b626800;
        bytes32 roleSlot = keccak256(abi.encode(wiper, base));
        vm.store(d.token, bytes32(uint256(roleSlot) + 1), t.GUARDIAN_ROLE());
        _expectCheck("WIPER admin is not DEFAULT_ADMIN");
    }

    function test_freshChecksCatchSupply() public {
        vm.prank(c.minter);
        t.mint(makeAddr("u"), 1);
        _expectCheck("unexpected supply");
        verifier.verify(c, d, false); // 운영 중 재검증에서는 통과
    }

    // ------------------------------------------------------------------
    // 설정 검증
    // ------------------------------------------------------------------

    function _expectInvalid(DeployConfig memory bad, string memory reason) internal {
        Deploy s = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(DeployConfigLib.InvalidConfig.selector, reason));
        s.deploy(bad, address(s));
    }

    function test_rejectsZeroHolder() public {
        DeployConfig memory bad = c;
        bad.opsSafe = address(0);
        _expectInvalid(bad, "ops_safe is zero");
    }

    function test_rejectsDuplicateHolders() public {
        DeployConfig memory bad = c;
        bad.treasurySafe = bad.recoverySafe;
        _expectInvalid(bad, "recovery_safe equals treasury_safe");
    }

    function test_rejectsBotEqualsOpsSafe() public {
        DeployConfig memory bad = c;
        bad.bot = bad.opsSafe;
        _expectInvalid(bad, "ops_safe equals bot");
    }

    function test_rejectsDeployerAsHolder() public {
        Deploy s = new Deploy();
        DeployConfig memory bad = c;
        bad.governanceSafe = address(s);
        vm.expectRevert(abi.encodeWithSelector(DeployConfigLib.InvalidConfig.selector, "governance_safe equals deployer"));
        s.deploy(bad, address(s));
    }

    function test_rejectsWrongChain() public {
        vm.chainId(11155111);
        _expectInvalid(c, "chain id mismatch");
    }

    function test_rejectsUnconfiguredChain() public {
        DeployConfig memory bad = c;
        bad.expectedChainId = 0;
        _expectInvalid(bad, "expected_chain_id is 0 (chain not configured)");
    }

    function test_rejectsEoaHoldersWhenContractsRequired() public {
        DeployConfig memory bad = c;
        bad.requireContractHolders = true;
        _expectInvalid(bad, "governance_safe has no code (not a Safe)");
    }

    function test_acceptsContractHoldersWhenRequired() public {
        DeployConfig memory ok = c;
        ok.requireContractHolders = true;
        ok.governanceSafe = address(new Dummy());
        ok.opsSafe = address(new Dummy());
        ok.recoverySafe = address(new Dummy());
        ok.treasurySafe = address(new Dummy());
        ok.minter = address(new Dummy());
        Deploy s = new Deploy();
        Deployment memory d2 = s.deploy(ok, address(s));
        verifier.verify(ok, d2, true);
    }

    /// @dev Sepolia 설정은 실제 Safe 주소로 채워져 있다. Safe 코드가 없는 체인(포크가 아닌 로컬)에서는
    ///      require_contract_holders 검사가 막는다. 실제 Sepolia에서의 통과 여부는 포크 시뮬레이션으로 확인한다.
    function test_sepoliaConfigRefusesWithoutSafeCode() public {
        DeployConfig memory sep = DeployConfigLib.load(string.concat(vm.projectRoot(), "/../config/deploy.sepolia.toml"));
        assertTrue(sep.requireContractHolders);
        vm.chainId(11155111);
        Deploy s = new Deploy();
        vm.expectRevert(
            abi.encodeWithSelector(DeployConfigLib.InvalidConfig.selector, "governance_safe has no code (not a Safe)")
        );
        s.deploy(sep, address(s));
    }

    function test_customConfigRefusesUntilFilled() public {
        DeployConfig memory custom =
            DeployConfigLib.load(string.concat(vm.projectRoot(), "/../config/deploy.custom.toml"));
        Deploy s = new Deploy();
        vm.expectRevert(
            abi.encodeWithSelector(DeployConfigLib.InvalidConfig.selector, "expected_chain_id is 0 (chain not configured)")
        );
        s.deploy(custom, address(s));
    }
}

contract Dummy {}

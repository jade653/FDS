// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StableToken} from "../../src/StableToken.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @notice 불변식 테스트용 핸들러. 역할별 행위자가 무작위 순서로 컨트랙트를 호출하고,
///         불변식 검사에 필요한 고스트 상태를 기록한다.
///         핸들러 안에서 "반드시 실패해야 하는" 호출이 성공하면 플래그를 올리고, 불변식이 그 플래그를 본다.
contract Handler is Test {
    StableToken public token;
    ProxyAdmin public proxyAdmin;

    // 역할 보유자
    address public admin;
    address public guardian;
    address public bot; // FREEZER만 가진 키
    address public unfreezer;
    address public pauser;
    address public wiper;
    address public masterMinter;

    address[] public minters;
    address[] public users; // 토큰을 들 수 있는 모든 주소 (minters 포함)
    bytes32[] public caseIds;

    // ------------------------------------------------------------------
    // 고스트 상태
    // ------------------------------------------------------------------

    /// @dev 불변식 2: 동결 시점(또는 wipe 직후)의 잔고. 동결 중에는 이 값과 같아야 한다.
    mapping(address => uint256) public frozenBalance;
    /// @dev 불변식 4: minter별 누적 발행량과 설정된 한도의 합.
    mapping(address => uint256) public totalMinted;
    mapping(address => uint256) public totalAllowanceConfigured;
    /// @dev 불변식 5: 보호 주소가 GUARDIAN 없이 동결되면 true.
    bool public protectedFrozenWithoutGuardian;
    /// @dev 불변식 6: 일시정지 중 freeze가 실패하면 true.
    bool public freezeFailedWhilePaused;
    /// @dev 불변식 3: FREEZER만 가진 키가 동결 외의 일을 해내면 true.
    bool public freezerDidForbiddenAction;

    // 호출 통계 (디버깅용)
    mapping(bytes32 => uint256) public calls;

    modifier countCall(bytes32 key) {
        calls[key]++;
        _;
    }

    constructor(
        StableToken token_,
        ProxyAdmin proxyAdmin_,
        address admin_,
        address guardian_,
        address bot_,
        address unfreezer_,
        address pauser_,
        address wiper_,
        address masterMinter_,
        address[] memory minters_,
        address[] memory plainUsers
    ) {
        token = token_;
        proxyAdmin = proxyAdmin_;
        admin = admin_;
        guardian = guardian_;
        bot = bot_;
        unfreezer = unfreezer_;
        pauser = pauser_;
        wiper = wiper_;
        masterMinter = masterMinter_;
        minters = minters_;
        for (uint256 i = 0; i < plainUsers.length; ++i) {
            users.push(plainUsers[i]);
        }
        for (uint256 i = 0; i < minters_.length; ++i) {
            users.push(minters_[i]);
        }
        caseIds.push(keccak256("case-A"));
        caseIds.push(keccak256("case-B"));
        caseIds.push(keccak256("case-C"));
    }

    // ------------------------------------------------------------------
    // 선택 헬퍼
    // ------------------------------------------------------------------

    function _user(uint256 seed) internal view returns (address) {
        return users[seed % users.length];
    }

    function _minter(uint256 seed) internal view returns (address) {
        return minters[seed % minters.length];
    }

    function _case(uint256 seed) internal view returns (bytes32) {
        return caseIds[seed % caseIds.length];
    }

    function usersLength() external view returns (uint256) {
        return users.length;
    }

    function mintersLength() external view returns (uint256) {
        return minters.length;
    }

    function caseIdsLength() external view returns (uint256) {
        return caseIds.length;
    }

    // ------------------------------------------------------------------
    // 시간
    // ------------------------------------------------------------------

    function warp(uint256 secs) external countCall("warp") {
        secs = bound(secs, 1, 2 hours);
        vm.warp(block.timestamp + secs);
    }

    // ------------------------------------------------------------------
    // 사용자 행위
    // ------------------------------------------------------------------

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external countCall("transfer") {
        address from = _user(fromSeed);
        address to = _user(toSeed);
        amount = bound(amount, 0, token.balanceOf(from));
        vm.prank(from);
        try token.transfer(to, amount) {} catch {}
    }

    function approve(uint256 ownerSeed, uint256 spenderSeed, uint256 amount) external countCall("approve") {
        address owner = _user(ownerSeed);
        address spender = _user(spenderSeed);
        vm.prank(owner);
        try token.approve(spender, amount) {} catch {}
    }

    function transferFrom(uint256 spenderSeed, uint256 fromSeed, uint256 toSeed, uint256 amount)
        external
        countCall("transferFrom")
    {
        address spender = _user(spenderSeed);
        address from = _user(fromSeed);
        address to = _user(toSeed);
        amount = bound(amount, 0, token.balanceOf(from));
        vm.prank(spender);
        try token.transferFrom(from, to, amount) {} catch {}
    }

    // ------------------------------------------------------------------
    // 발행
    // ------------------------------------------------------------------

    function configureMinter(uint256 minterSeed, uint256 allowance_) external countCall("configureMinter") {
        address m = _minter(minterSeed);
        allowance_ = bound(allowance_, 0, 1_000_000e6);
        vm.prank(masterMinter);
        token.configureMinter(m, allowance_);
        totalAllowanceConfigured[m] += allowance_;
    }

    function removeMinter(uint256 minterSeed) external countCall("removeMinter") {
        address m = _minter(minterSeed);
        vm.prank(masterMinter);
        try token.removeMinter(m) {} catch {}
    }

    function mint(uint256 minterSeed, uint256 toSeed, uint256 amount) external countCall("mint") {
        address m = _minter(minterSeed);
        address to = _user(toSeed);
        amount = bound(amount, 1, 100_000e6);
        vm.prank(m);
        try token.mint(to, amount) {
            totalMinted[m] += amount;
        } catch {}
    }

    function mintForRecovery(uint256 minterSeed, uint256 toSeed, uint256 amount, uint256 caseSeed)
        external
        countCall("mintForRecovery")
    {
        address m = _minter(minterSeed);
        address to = _user(toSeed);
        bytes32 caseId = _case(caseSeed);
        // 상한 근처를 자주 건드리도록 소각 합계를 기준으로 금액을 고른다.
        uint256 wiped = token.wipedByCase(caseId);
        amount = bound(amount, 1, wiped + 1_000e6);
        vm.prank(m);
        try token.mintForRecovery(to, amount, caseId) {
            totalMinted[m] += amount;
        } catch {}
    }

    function burn(uint256 minterSeed, uint256 amount) external countCall("burn") {
        address m = _minter(minterSeed);
        amount = bound(amount, 0, token.balanceOf(m));
        vm.prank(m);
        try token.burn(amount) {} catch {}
    }

    // ------------------------------------------------------------------
    // 동결·해제·소각
    // ------------------------------------------------------------------

    function freeze(uint256 userSeed) external countCall("freeze") {
        address a = _user(userSeed);
        bool wasProtected = token.isProtected(a);
        bool wasFrozen = token.isFrozen(a);
        bool wasPaused = token.paused();
        vm.prank(bot);
        try token.freeze(a, keccak256("R1")) {
            if (wasProtected) protectedFrozenWithoutGuardian = true;
            if (!wasFrozen) frozenBalance[a] = token.balanceOf(a);
        } catch {
            if (!wasProtected && wasPaused) freezeFailedWhilePaused = true;
        }
    }

    function freezeBatch(uint256 seed, uint256 n) external countCall("freezeBatch") {
        n = bound(n, 1, 60);
        address[] memory list = new address[](n);
        bool anyProtected;
        for (uint256 i = 0; i < n; ++i) {
            list[i] = _user(uint256(keccak256(abi.encode(seed, i))));
            if (token.isProtected(list[i])) anyProtected = true;
        }
        uint256[] memory before = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            before[i] = token.isFrozen(list[i]) ? 1 : 0;
        }
        vm.prank(bot);
        try token.freezeBatch(list, keccak256("R3")) {
            if (anyProtected) protectedFrozenWithoutGuardian = true;
            for (uint256 i = 0; i < n; ++i) {
                if (before[i] == 0) frozenBalance[list[i]] = token.balanceOf(list[i]);
            }
        } catch {}
    }

    function guardianFreezeProtected(uint256 userSeed) external countCall("guardianFreeze") {
        address a = _user(userSeed);
        bool wasFrozen = token.isFrozen(a);
        vm.prank(guardian);
        try token.freeze(a, keccak256("GUARDIAN")) {
            if (!wasFrozen) frozenBalance[a] = token.balanceOf(a);
        } catch {}
    }

    function unfreeze(uint256 userSeed) external countCall("unfreeze") {
        address a = _user(userSeed);
        vm.prank(unfreezer);
        try token.unfreeze(a) {} catch {}
    }

    function wipeFrozen(uint256 userSeed, uint256 caseSeed) external countCall("wipeFrozen") {
        address a = _user(userSeed);
        vm.prank(wiper);
        try token.wipeFrozen(a, _case(caseSeed)) {
            frozenBalance[a] = 0;
        } catch {}
    }

    function setProtected(uint256 userSeed, bool on) external countCall("setProtected") {
        vm.prank(admin);
        token.setProtected(_user(userSeed), on);
    }

    function setMinFreezeAge(uint64 secs) external countCall("setMinFreezeAge") {
        secs = uint64(bound(secs, 0, 1 hours));
        vm.prank(admin);
        token.setMinFreezeAge(secs);
    }

    // ------------------------------------------------------------------
    // 일시정지
    // ------------------------------------------------------------------

    function pause() external countCall("pause") {
        vm.prank(pauser);
        try token.pause() {} catch {}
    }

    function unpause() external countCall("unpause") {
        vm.prank(pauser);
        try token.unpause() {} catch {}
    }

    /// @dev 불변식 6: 일시정지 상태를 만든 뒤 봇이 동결을 시도한다. 보호 주소가 아니면 반드시 성공해야 한다.
    function freezeWhilePaused(uint256 userSeed) external countCall("freezeWhilePaused") {
        if (!token.paused()) {
            vm.prank(pauser);
            token.pause();
        }
        address a = _user(userSeed);
        if (token.isProtected(a)) return;
        bool wasFrozen = token.isFrozen(a);
        vm.prank(bot);
        try token.freeze(a, keccak256("PAUSED")) {
            if (!wasFrozen) frozenBalance[a] = token.balanceOf(a);
        } catch {
            freezeFailedWhilePaused = true;
        }
    }

    // ------------------------------------------------------------------
    // 불변식 3: FREEZER만 가진 키가 동결 외의 일을 시도한다. 하나라도 성공하면 플래그.
    // ------------------------------------------------------------------

    function freezerTriesForbidden(uint256 seed, uint256 which) external countCall("freezerForbidden") {
        address a = _user(seed);
        which = bound(which, 0, 11);
        vm.startPrank(bot);
        if (which == 0) {
            try token.unfreeze(a) {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 1) {
            try token.wipeFrozen(a, _case(seed)) {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 2) {
            try token.mint(a, 1) {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 3) {
            try token.mintForRecovery(a, 1, _case(seed)) {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 4) {
            try token.burn(1) {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 5) {
            try token.pause() {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 6) {
            try token.unpause() {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 7) {
            try token.configureMinter(bot, 1) {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 8) {
            try token.grantRole(token.FREEZER_ROLE(), a) {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 9) {
            try token.grantRole(token.DEFAULT_ADMIN_ROLE(), bot) {
                freezerDidForbiddenAction = true;
            } catch {}
        } else if (which == 10) {
            try token.setProtected(a, false) {
                freezerDidForbiddenAction = true;
            } catch {}
        } else {
            try proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(address(token)), address(token), "") {
                freezerDidForbiddenAction = true;
            } catch {}
        }
        vm.stopPrank();
    }
}

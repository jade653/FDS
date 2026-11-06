// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title StableToken
/// @notice 법정화폐 담보 스테이블코인. docs/design.md 5장의 구현이다.
///
///         - 동결 검사는 `_update`(from, to), `transferFrom`(spender), 4인자 `_approve`(owner, spender) 세 곳.
///         - 회수는 동결 → `wipeFrozen` 소각 → `mintForRecovery` 재발행. 강제이전 함수는 없다.
///         - `wipeFrozen`만 `ERC20Upgradeable._update`를 직접 호출해 동결·일시정지를 우회한다.
///         - 사건별 회계 `reissuedByCase[caseId] <= wipedByCase[caseId]`를 온체인에서 강제한다.
///         - 역할 admin: FREEZER → GUARDIAN, MINTER → MASTER_MINTER, 나머지 → DEFAULT_ADMIN(타임락).
/// @custom:oz-upgrades
contract StableToken is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // 역할 (design.md 6장 표. 여기에 없는 역할은 추가하지 않는다)
    // ------------------------------------------------------------------

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");
    bytes32 public constant UNFREEZER_ROLE = keccak256("UNFREEZER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant WIPER_ROLE = keccak256("WIPER_ROLE");
    bytes32 public constant MASTER_MINTER_ROLE = keccak256("MASTER_MINTER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant RESCUER_ROLE = keccak256("RESCUER_ROLE");

    /// @notice `freezeBatch` 한 번에 동결할 수 있는 최대 주소 수 (design.md 10장).
    uint256 public constant FREEZE_BATCH_MAX = 50;

    // ------------------------------------------------------------------
    // 저장소 (ERC-7201)
    // ------------------------------------------------------------------

    /// @custom:storage-location erc7201:stabletoken.storage.StableToken
    struct StableTokenStorage {
        /// @dev 동결 시각. 0이면 동결되지 않음.
        mapping(address account => uint64) frozenAt;
        /// @dev minter별 남은 발행 한도.
        mapping(address minter => uint256) minterAllowance;
        /// @dev 봇(FREEZER만 가진 키)이 동결할 수 없는 주소. GUARDIAN이 있어야 동결 가능.
        mapping(address account => bool) isProtected;
        /// @dev 동결 후 소각이 가능해지기까지의 최소 대기 시간(초).
        uint64 minFreezeAge;
        /// @dev 사건별 누적 소각액.
        mapping(bytes32 caseId => uint256) wipedByCase;
        /// @dev 사건별 누적 재발행액. `wipedByCase`를 넘지 못한다.
        mapping(bytes32 caseId => uint256) reissuedByCase;
    }

    // keccak256(abi.encode(uint256(keccak256("stabletoken.storage.StableToken")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STABLE_TOKEN_STORAGE_LOCATION =
        0xb501e00636b6ac58295744dec91f69f75dc5ab9d8e86002747c3f6f16a093300;

    function _getStableTokenStorage() private pure returns (StableTokenStorage storage $) {
        assembly {
            $.slot := STABLE_TOKEN_STORAGE_LOCATION
        }
    }

    // ------------------------------------------------------------------
    // 이벤트 (design.md 5.3 표)
    // ------------------------------------------------------------------

    event Frozen(address indexed account, address indexed operator, bytes32 indexed reason);
    event Unfrozen(address indexed account, address indexed operator);
    event FrozenFundsWiped(bytes32 indexed caseId, address indexed account, uint256 amount);
    event MinterConfigured(address indexed minter, uint256 allowance);
    event MinterRemoved(address indexed minter);
    event Mint(address indexed minter, address indexed to, uint256 amount);
    event RecoveryReissued(bytes32 indexed caseId, address indexed to, uint256 amount);
    event Burn(address indexed minter, uint256 amount);
    event ProtectedSet(address indexed account, bool on);
    event MinFreezeAgeSet(uint64 secs);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // 오류
    // ------------------------------------------------------------------

    error AccountFrozen(address account);
    error AccountNotFrozen(address account);
    error ProtectedAccount(address account);
    error BatchTooLarge(uint256 length, uint256 max);
    error FreezeTooRecent(address account, uint64 availableAt);
    error NothingToWipe(address account);
    error MinterAllowanceExceeded(address minter, uint256 allowance, uint256 requested);
    error RecoveryExceedsWiped(bytes32 caseId, uint256 wiped, uint256 reissued, uint256 requested);
    error NotMinter(address account);
    error UseMinterFunctions();
    error ZeroAddress();
    error ZeroAmount();

    // ------------------------------------------------------------------
    // 초기화
    // ------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param name_ 토큰 이름
    /// @param symbol_ 토큰 심볼
    /// @param admin DEFAULT_ADMIN_ROLE 보유자 (배포 시 TimelockController)
    /// @param minFreezeAge_ 동결 후 소각 대기 시간(초)
    function initialize(string memory name_, string memory symbol_, address admin, uint64 minFreezeAge_)
        external
        initializer
    {
        if (admin == address(0)) revert ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __Pausable_init();

        _setRoleAdmin(FREEZER_ROLE, GUARDIAN_ROLE);
        _setRoleAdmin(MINTER_ROLE, MASTER_MINTER_ROLE);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        _getStableTokenStorage().minFreezeAge = minFreezeAge_;
        emit MinFreezeAgeSet(minFreezeAge_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ------------------------------------------------------------------
    // 조회
    // ------------------------------------------------------------------

    function frozenAt(address account) external view returns (uint64) {
        return _getStableTokenStorage().frozenAt[account];
    }

    function isFrozen(address account) public view returns (bool) {
        return _getStableTokenStorage().frozenAt[account] != 0;
    }

    function minterAllowance(address minter) external view returns (uint256) {
        return _getStableTokenStorage().minterAllowance[minter];
    }

    function isProtected(address account) external view returns (bool) {
        return _getStableTokenStorage().isProtected[account];
    }

    function minFreezeAge() external view returns (uint64) {
        return _getStableTokenStorage().minFreezeAge;
    }

    function wipedByCase(bytes32 caseId) external view returns (uint256) {
        return _getStableTokenStorage().wipedByCase[caseId];
    }

    function reissuedByCase(bytes32 caseId) external view returns (uint256) {
        return _getStableTokenStorage().reissuedByCase[caseId];
    }

    // ------------------------------------------------------------------
    // 동결 (FREEZER / GUARDIAN / UNFREEZER)
    // ------------------------------------------------------------------

    /// @notice 주소를 동결한다. 이미 동결이면 아무것도 하지 않고 성공한다. 보호 주소는 GUARDIAN도 있어야 한다.
    ///         일시정지 중에도 동작한다.
    function freeze(address account, bytes32 reason) external onlyRole(FREEZER_ROLE) {
        _freeze(account, reason);
    }

    /// @notice 여러 주소를 한 트랜잭션에 동결한다. 최대 `FREEZE_BATCH_MAX`개.
    function freezeBatch(address[] calldata accounts, bytes32 reason) external onlyRole(FREEZER_ROLE) {
        if (accounts.length > FREEZE_BATCH_MAX) revert BatchTooLarge(accounts.length, FREEZE_BATCH_MAX);
        for (uint256 i = 0; i < accounts.length; ++i) {
            _freeze(accounts[i], reason);
        }
    }

    /// @notice 동결을 해제한다. 동결되지 않은 주소면 실패한다.
    function unfreeze(address account) external onlyRole(UNFREEZER_ROLE) {
        StableTokenStorage storage $ = _getStableTokenStorage();
        if ($.frozenAt[account] == 0) revert AccountNotFrozen(account);
        $.frozenAt[account] = 0;
        emit Unfrozen(account, _msgSender());
    }

    function _freeze(address account, bytes32 reason) internal {
        if (account == address(0)) revert ZeroAddress();
        StableTokenStorage storage $ = _getStableTokenStorage();
        if ($.isProtected[account] && !hasRole(GUARDIAN_ROLE, _msgSender())) revert ProtectedAccount(account);
        if ($.frozenAt[account] != 0) return;
        $.frozenAt[account] = uint64(block.timestamp);
        emit Frozen(account, _msgSender(), reason);
    }

    // ------------------------------------------------------------------
    // 회수 (WIPER)
    // ------------------------------------------------------------------

    /// @notice 동결된 지 `minFreezeAge`가 지난 주소의 잔고 전부를 소각하고 사건 회계에 더한다.
    ///         이 함수만 `ERC20Upgradeable._update`를 직접 호출해 동결 검사와 일시정지를 우회한다.
    ///         소각 후에도 동결 상태는 유지된다.
    function wipeFrozen(address account, bytes32 caseId) external onlyRole(WIPER_ROLE) {
        StableTokenStorage storage $ = _getStableTokenStorage();
        uint64 frozenSince = $.frozenAt[account];
        if (frozenSince == 0) revert AccountNotFrozen(account);
        uint64 availableAt = frozenSince + $.minFreezeAge;
        if (block.timestamp < availableAt) revert FreezeTooRecent(account, availableAt);

        uint256 amount = balanceOf(account);
        if (amount == 0) revert NothingToWipe(account);

        $.wipedByCase[caseId] += amount;
        // 의도적 우회: 이 컨트랙트의 _update override(동결·일시정지 검사)를 거치지 않는다.
        ERC20Upgradeable._update(account, address(0), amount);
        emit FrozenFundsWiped(caseId, account, amount);
    }

    // ------------------------------------------------------------------
    // 발행 (MASTER_MINTER / MINTER)
    // ------------------------------------------------------------------

    /// @notice MINTER 역할을 부여하고 누적 발행 한도를 설정한다. 한도는 덮어쓴다.
    function configureMinter(address minter, uint256 allowance) external onlyRole(MASTER_MINTER_ROLE) {
        if (minter == address(0)) revert ZeroAddress();
        _grantRole(MINTER_ROLE, minter);
        _getStableTokenStorage().minterAllowance[minter] = allowance;
        emit MinterConfigured(minter, allowance);
    }

    /// @notice MINTER 역할을 회수하고 한도를 0으로 만든다.
    function removeMinter(address minter) external onlyRole(MASTER_MINTER_ROLE) {
        if (!hasRole(MINTER_ROLE, minter)) revert NotMinter(minter);
        _revokeRole(MINTER_ROLE, minter);
        _getStableTokenStorage().minterAllowance[minter] = 0;
        emit MinterRemoved(minter);
    }

    /// @notice 한도 내에서 발행한다. 일시정지 중이거나 minter·수신자가 동결이면 실패한다.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mintWithAllowance(to, amount);
        emit Mint(_msgSender(), to, amount);
    }

    /// @notice 회수 재발행. `mint`와 같은 한도를 쓰고, 사건별로 소각 합계를 넘지 못한다.
    function mintForRecovery(address to, uint256 amount, bytes32 caseId) external onlyRole(MINTER_ROLE) {
        StableTokenStorage storage $ = _getStableTokenStorage();
        uint256 wiped = $.wipedByCase[caseId];
        uint256 reissued = $.reissuedByCase[caseId];
        if (reissued + amount > wiped) revert RecoveryExceedsWiped(caseId, wiped, reissued, amount);
        $.reissuedByCase[caseId] = reissued + amount;

        _mintWithAllowance(to, amount);
        emit RecoveryReissued(caseId, to, amount);
    }

    /// @notice minter 자기 잔고를 소각한다 (상환용). 일시정지 중에는 실패한다.
    function burn(uint256 amount) external onlyRole(MINTER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        address minter = _msgSender();
        _burn(minter, amount);
        emit Burn(minter, amount);
    }

    function _mintWithAllowance(address to, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        address minter = _msgSender();
        _requireNotFrozen(minter);

        StableTokenStorage storage $ = _getStableTokenStorage();
        uint256 allowance_ = $.minterAllowance[minter];
        if (allowance_ < amount) revert MinterAllowanceExceeded(minter, allowance_, amount);
        unchecked {
            $.minterAllowance[minter] = allowance_ - amount;
        }
        _mint(to, amount);
    }

    // ------------------------------------------------------------------
    // 일시정지 (PAUSER)
    // ------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------
    // 관리 (DEFAULT_ADMIN / RESCUER)
    // ------------------------------------------------------------------

    function setProtected(address account, bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        _getStableTokenStorage().isProtected[account] = on;
        emit ProtectedSet(account, on);
    }

    function setMinFreezeAge(uint64 secs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _getStableTokenStorage().minFreezeAge = secs;
        emit MinFreezeAgeSet(secs);
    }

    /// @notice 이 컨트랙트 주소에 잘못 들어온 토큰을 반환한다. 이 토큰 자체도 가능하며 그 경우 동결·일시정지 검사를 거친다.
    function rescueERC20(address token, address to, uint256 amount) external onlyRole(RESCUER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ------------------------------------------------------------------
    // 역할 관리 제한: MINTER는 configureMinter / removeMinter로만 바꾼다
    // ------------------------------------------------------------------

    function grantRole(bytes32 role, address account) public override {
        if (role == MINTER_ROLE) revert UseMinterFunctions();
        super.grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account) public override {
        if (role == MINTER_ROLE) revert UseMinterFunctions();
        super.revokeRole(role, account);
    }

    /// @dev minter가 스스로 역할을 내려놓으면 한도도 같이 0으로 만든다.
    function renounceRole(bytes32 role, address callerConfirmation) public override {
        bool wasMinter = role == MINTER_ROLE && hasRole(MINTER_ROLE, callerConfirmation);
        super.renounceRole(role, callerConfirmation);
        if (wasMinter) {
            _getStableTokenStorage().minterAllowance[callerConfirmation] = 0;
            emit MinterRemoved(callerConfirmation);
        }
    }

    // ------------------------------------------------------------------
    // 동결 검사 (design.md 5.2). 잔고가 움직이는 모든 경로에서 세 주소를 검사한다.
    // ------------------------------------------------------------------

    /// @dev from·to 동결 검사와 일시정지. mint(from = 0)와 burn(to = 0)은 0 주소 쪽 검사를 건너뛴다.
    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        if (from != address(0)) _requireNotFrozen(from);
        if (to != address(0)) _requireNotFrozen(to);
        super._update(from, to, value);
    }

    /// @dev spender(`_msgSender()`) 동결 검사. 무한 allowance는 `_approve`를 거치지 않으므로 여기가 최종 방어선이다.
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _requireNotFrozen(_msgSender());
        return super.transferFrom(from, to, value);
    }

    /// @dev owner·spender 동결 검사. `approve`, `permit`, `_spendAllowance`(유한 allowance) 모두 이 경로를 탄다.
    function _approve(address owner, address spender, uint256 value, bool emitEvent) internal override {
        _requireNotFrozen(owner);
        _requireNotFrozen(spender);
        super._approve(owner, spender, value, emitEvent);
    }

    function _requireNotFrozen(address account) internal view {
        if (_getStableTokenStorage().frozenAt[account] != 0) revert AccountFrozen(account);
    }
}

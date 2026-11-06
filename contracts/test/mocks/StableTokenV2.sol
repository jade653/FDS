// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StableToken} from "../../src/StableToken.sol";

/// @notice 업그레이드 테스트용 가상의 V2. V1 저장소는 건드리지 않고 새 네임스페이스에 상태를 하나 더한다.
///         실제 V2가 아니며, 레이아웃 호환 검사(`Upgrades.upgradeProxy`)와 상태 보존 확인에만 쓴다.
///         이미 초기화된 프록시의 V2는 부모 initializer를 다시 부르지 않고 reinitializer만 쓰므로
///         upgrades-core의 missing-initializer 검사는 이 목에서만 끈다.
/// @custom:oz-upgrades-from StableToken
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract StableTokenV2 is StableToken {
    /// @custom:storage-location erc7201:stabletoken.storage.StableTokenV2
    struct V2Storage {
        uint256 upgradeMarker;
    }

    // keccak256(abi.encode(uint256(keccak256("stabletoken.storage.StableTokenV2")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant V2_STORAGE_LOCATION = 0xd6382e11548e030878e41f046d6525e8097b11dc8ac8d95571ea42de3da6df00;

    function _getV2Storage() private pure returns (V2Storage storage $) {
        assembly {
            $.slot := V2_STORAGE_LOCATION
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() StableToken() {}

    function initializeV2(uint256 marker) external reinitializer(2) {
        _getV2Storage().upgradeMarker = marker;
    }

    function version() external pure returns (uint256) {
        return 2;
    }

    function upgradeMarker() external view returns (uint256) {
        return _getV2Storage().upgradeMarker;
    }
}

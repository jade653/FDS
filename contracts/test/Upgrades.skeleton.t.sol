// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Upgrades} from "@openzeppelin/foundry-upgrades/Upgrades.sol";
import {StableToken} from "../src/StableToken.sol";

/// @notice 0단계: openzeppelin-foundry-upgrades 검사(ffi + upgrades-core)가 이 환경에서 실제로 도는지 확인한다.
///         Upgrades.deployTransparentProxy는 배포 전에 구현체의 업그레이드 안전성을 검증한다.
contract UpgradesSkeletonTest is Test {
    function test_upgradeSafetyValidationRuns() public {
        address admin = makeAddr("admin");
        address proxyOwner = makeAddr("proxyOwner");
        address proxy = Upgrades.deployTransparentProxy(
            "StableToken.sol", proxyOwner, abi.encodeCall(StableToken.initialize, ("Stable Token", "STB", admin))
        );
        assertEq(StableToken(proxy).decimals(), 6);
        assertTrue(Upgrades.getAdminAddress(proxy) != address(0));
    }
}

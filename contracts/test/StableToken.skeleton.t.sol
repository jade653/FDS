// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StableToken} from "../src/StableToken.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @notice 0단계 스모크 테스트. 툴체인(solc 0.8.28, evm paris, OZ v5.4.0)이 프록시 배포까지 동작하는지만 본다.
///         1단계에서 docs/design.md 12장의 본 테스트로 교체한다.
contract StableTokenSkeletonTest is Test {
    StableToken internal token;
    address internal admin = makeAddr("admin");
    address internal proxyOwner = makeAddr("proxyOwner");

    function setUp() public {
        StableToken impl = new StableToken();
        bytes memory init = abi.encodeCall(StableToken.initialize, ("Stable Token", "STB", admin));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), proxyOwner, init);
        token = StableToken(address(proxy));
    }

    function test_decimalsIsSix() public view {
        assertEq(token.decimals(), 6);
    }

    function test_adminHasDefaultAdminRole() public view {
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_implementationCannotBeInitialized() public {
        StableToken impl = new StableToken();
        vm.expectRevert();
        impl.initialize("x", "x", admin);
    }
}

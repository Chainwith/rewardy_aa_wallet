// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEntryPoint {}

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract RewardyDualEntryAccount {
    using ECDSA for bytes32;

    IEntryPoint public immutable ENTRY_POINT;
    address public immutable ALT_ENTRY_POINT;

    uint256 public nonce;

    struct BatchCall {
        address target;
        uint256 value;
        bytes data;
    }

    struct InternalCall {
        address to;
        uint256 value;
        bytes data;
    }

    struct Fee {
        address token;      // zero = ETH
        uint256 amount;     // zero = no fee
        address receiver;
    }

    event CallExecuted(address indexed to, uint256 value, bytes data);
    event BatchExecuted(uint256 indexed nonce, uint256 callCount, bytes32 callsHash);
    event FeeCharged(address indexed token, address indexed to, uint256 amount);

    constructor(address entryPoint_, address altEntryPoint_) {
        require(entryPoint_ != address(0), "EP=0");
        ENTRY_POINT = IEntryPoint(entryPoint_);
        ALT_ENTRY_POINT = altEntryPoint_;
    }

    modifier onlyEP() {
        address ep = address(ENTRY_POINT);
        require(
            msg.sender == ep ||
                (ALT_ENTRY_POINT != address(0) && msg.sender == ALT_ENTRY_POINT),
            "only EP"
        );
        _;
    }

    /* ========================= 4337 PATH ========================= */

    function execute(address target, uint256 value, bytes calldata data) external payable onlyEP {
        InternalCall;
        calls[0] = InternalCall({to: target, value: value, data: data});
        _executeBatch(calls);
    }

    function executeBatch(BatchCall[] calldata calls_) external payable onlyEP {
        InternalCall[] memory calls = new InternalCall[](calls_.length);
        for (uint256 i = 0; i < calls_.length; i++) {
            calls[i] = InternalCall({
                to: calls_[i].target,
                value: calls_[i].value,
                data: calls_[i].data
            });
        }
        _executeBatch(calls);
    }

    function validateUserOp(
        PackedUserOperation calldata,
        bytes32,
        uint256 missingAccountFunds
    ) external onlyEP returns (uint256) {
        if (missingAccountFunds > 0) {
            (bool ok, ) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok;
        }
        return 0;
    }

    function entryPoint() external view returns (IEntryPoint) {
        return ENTRY_POINT;
    }

    function altEntryPoint() external view returns (address) {
        return ALT_ENTRY_POINT;
    }

    function getNonce() external view returns (uint256) {
        return nonce;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        address recovered = ECDSA.recover(hash, signature);
        return recovered == address(this) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    /* ========================= 7702 TYPE-4 PATH ========================= */

    function executeWithAuthorization(
        InternalCall[] calldata calls,
        uint256 deadline,
        bytes calldata signature
    ) external payable {
        Fee memory fee = Fee(address(0), 0, address(0));
        _verifyAndExecute(calls, fee, deadline, signature);
    }

    function executeWithFee(
        InternalCall[] calldata calls,
        Fee calldata fee,
        uint256 deadline,
        bytes calldata signature
    ) external payable {
        _verifyAndExecute(calls, fee, deadline, signature);
    }

    function executeDirect(InternalCall[] calldata calls) external payable {
        require(msg.sender == address(this), "Rewardy: invalid authority");
        _executeBatch(calls);
    }

    /* ========================= INTERNAL ========================= */

    function _verifyAndExecute(
        InternalCall[] calldata calls,
        Fee memory fee,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        require(block.timestamp <= deadline, "Rewardy: expired");

        bytes32 callsHash = _hashCallsCalldata(calls);
        bytes32 digest = keccak256(
            abi.encode(callsHash, fee.token, fee.amount, fee.receiver, nonce, deadline)
        );
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(digest);
        address recovered = ECDSA.recover(ethHash, signature);
        require(recovered == address(this), "Rewardy: bad signature");

        if (fee.amount > 0) {
            if (fee.token == address(0)) {
                (bool ok, ) = payable(fee.receiver).call{value: fee.amount}("");
                require(ok, "Rewardy: fee eth failed");
            } else {
                require(IERC20(fee.token).transfer(fee.receiver, fee.amount), "Rewardy: fee token failed");
            }
            emit FeeCharged(fee.token, fee.receiver, fee.amount);
        }

        _executeBatch(calls);
    }

    function _executeBatch(InternalCall[] memory calls) internal {
        uint256 current = nonce;
        nonce = current + 1;

        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, ) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            require(ok, "Rewardy: call reverted");
            emit CallExecuted(calls[i].to, calls[i].value, calls[i].data);
        }

        emit BatchExecuted(current, calls.length, _hashCallsMemory(calls));
    }

    function _hashCallsCalldata(InternalCall[] calldata calls) internal pure returns (bytes32) {
        bytes memory enc;
        for (uint256 i = 0; i < calls.length; i++) {
            enc = abi.encodePacked(enc, calls[i].to, calls[i].value, calls[i].data);
        }
        return keccak256(enc);
    }

    function _hashCallsMemory(InternalCall[] memory calls) internal pure returns (bytes32) {
        bytes memory enc;
        for (uint256 i = 0; i < calls.length; i++) {
            enc = abi.encodePacked(enc, calls[i].to, calls[i].value, calls[i].data);
        }
        return keccak256(enc);
    }

    receive() external payable {}
    fallback() external payable {}
}

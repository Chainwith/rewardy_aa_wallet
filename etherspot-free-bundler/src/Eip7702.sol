// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* ---------------- 4337 v0.8 minimal types ---------------- */
interface IEntryPoint {}

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits; // (verificationGasLimit, callGasLimit)
    uint256 preVerificationGas;
    bytes32 gasFees; // (maxPriorityFeePerGas, maxFeePerGas)
    bytes paymasterAndData;
    bytes signature;
}

/* ---------------- OZ utils ---------------- */
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title Rewardy7702AA
 * @notice 7702(type-4) & 4337(v0.8) 겸용 구현
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract Rewardy7702AA {
    using ECDSA for bytes32;

    /* ---------- 4337 required ---------- */
    IEntryPoint public immutable ENTRY_POINT; // 캐노니컬 v0.8 EP (예: 0x5FF1...)
    address public immutable ALT_ENTRY_POINT; // 번들러가 시뮬레이션에 쓰는 EP(예: 0x4337...f108). 없으면 address(0)

    /* ---------- Shared state ---------- */
    /// @dev slot0: 7702 전용 배치 nonce (EOA별 스토리지 호환)
    uint256 public nonce;

    /* ---------- Simple7702 ABI용 ---------- */
    struct BatchCall {
        address target;
        uint256 value;
        bytes data;
    }

    /* ---------- 내부 공통 실행용 ---------- */
    struct InternalCall {
        address to;
        uint256 value;
        bytes data;
    }

    /* ---------- 7702 수수료 구조 ---------- */
    struct Fee {
        address token; // 0x0 = ETH fee
        uint256 amount; // 0 = no fee
        address receiver;
    }

    event CallExecuted(address indexed to, uint256 value, bytes data);
    event BatchExecuted(
        uint256 indexed nonce,
        uint256 callCount,
        bytes32 callsHash
    );
    event FeeCharged(address indexed token, address indexed to, uint256 amount);

    constructor(address entryPoint_, address altEntryPoint_) {
        require(entryPoint_ != address(0), "EP=0");
        ENTRY_POINT = IEntryPoint(entryPoint_);
        ALT_ENTRY_POINT = altEntryPoint_;
    }

    /* ---------------- EP 가드 ---------------- */
    modifier onlyEP() {
        address ep = address(ENTRY_POINT);
        require(
            msg.sender == ep ||
                (ALT_ENTRY_POINT != address(0) &&
                    msg.sender == ALT_ENTRY_POINT),
            "only EP"
        );
        _;
    }

    /* =========================================================
                            4337 PATH
       ========================================================= */

    /// @notice Simple7702 단건 실행
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external payable onlyEP {
        InternalCall[] memory calls = new InternalCall[](1); // ✅ Declare and initialize
        calls[0] = InternalCall({to: target, value: value, data: data});
        _executeBatch(calls);
    }

    /// @notice Simple7702 배치 실행
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

    // v0.8: 검증 실패는 revert 대신 리턴코드로
    uint256 constant SIG_VALIDATION_FAILED = 1;

    /// @notice 4337 v0.8 검증 훅
    function validateUserOp(
        PackedUserOperation calldata /*userOp*/,
        bytes32 /*userOpHash*/,
        uint256 missingAccountFunds
    ) external onlyEP returns (uint256 validationData) {
        // ⚠️ 데모/통과 목적: 항상 통과(0) 리턴. 운영 시에는 userOp 파싱 + 실제 서명 검증 로직으로 교체하세요.
        if (missingAccountFunds > 0) {
            (bool ok, ) = payable(msg.sender).call{value: missingAccountFunds}(
                ""
            );
            ok; // ignore
        }
        return 0; // success
    }

    /// Simple7702 호환 뷰
    function entryPoint() external view returns (IEntryPoint) {
        return ENTRY_POINT;
    }

    /// ALT EP 뷰
    function altEntryPoint() external view returns (address) {
        return ALT_ENTRY_POINT;
    }

    /// Simple7702 호환 뷰
    function getNonce() external view returns (uint256) {
        return nonce;
    }

    /// (선택) EIP-1271 서명 검증 필요 시
    function isValidSignature(
        bytes32 hash,
        bytes calldata signature
    ) external view returns (bytes4) {
        address recovered = ECDSA.recover(hash, signature);
        return
            recovered == address(this)
                ? bytes4(0x1626ba7e)
                : bytes4(0xffffffff);
    }

    /* =========================================================
                           7702 TYPE-4 PATH
       ========================================================= */

    /// @notice 수수료 없이 7702 개인서명 배치 실행
    function executeWithAuthorization(
        InternalCall[] calldata calls,
        uint256 deadline,
        bytes calldata signature
    ) external payable {
        Fee memory fee = Fee(address(0), 0, address(0));
        _verifyAndExecute(calls, fee, deadline, signature);
    }

    /// @notice 수수료(ETH/ERC20) 포함 7702 개인서명 배치 실행
    function executeWithFee(
        InternalCall[] calldata calls,
        Fee calldata fee,
        uint256 deadline,
        bytes calldata signature
    ) external payable {
        _verifyAndExecute(calls, fee, deadline, signature);
    }

    /// @notice self-call 전용(계정이 직접 실행)
    function executeDirect(InternalCall[] calldata calls) external payable {
        require(msg.sender == address(this), "Rewardy: invalid authority");
        _executeBatch(calls);
    }

    /* =========================================================
                         INTERNAL COMMON LOGIC
       ========================================================= */

    // 7702 서명 규격 검증 + (옵션) 수수료 처리 + 실행
    function _verifyAndExecute(
        InternalCall[] calldata calls,
        Fee memory fee,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        require(block.timestamp <= deadline, "Rewardy: expired");

        bytes32 callsHash = _hashCallsCalldata(calls);
        // digest = keccak256(abi.encode(callsHash, fee.token, fee.amount, fee.receiver, nonce, deadline))
        bytes32 digest = keccak256(
            abi.encode(
                callsHash,
                fee.token,
                fee.amount,
                fee.receiver,
                nonce,
                deadline
            )
        );
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(digest);
        address recovered = ECDSA.recover(ethHash, signature);
        require(recovered == address(this), "Rewardy: bad signature");

        if (fee.amount > 0) {
            if (fee.token == address(0)) {
                (bool ok, ) = payable(fee.receiver).call{value: fee.amount}("");
                require(ok, "Rewardy: fee eth failed");
            } else {
                require(
                    IERC20(fee.token).transfer(fee.receiver, fee.amount),
                    "Rewardy: fee token failed"
                );
            }
            emit FeeCharged(fee.token, fee.receiver, fee.amount);
        }

        _executeBatch(calls);
    }

    // 공통 배치 실행
    function _executeBatch(InternalCall[] memory calls) internal {
        uint256 current = nonce;
        nonce = current + 1;

        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, ) = calls[i].to.call{value: calls[i].value}(
                calls[i].data
            );
            require(ok, "Rewardy: call reverted");
            emit CallExecuted(calls[i].to, calls[i].value, calls[i].data);
        }

        emit BatchExecuted(current, calls.length, _hashCallsMemory(calls));
    }

    /* ---------- hashing helpers ---------- */

    function _hashCallsCalldata(
        InternalCall[] calldata calls
    ) internal pure returns (bytes32) {
        bytes memory enc;
        for (uint256 i = 0; i < calls.length; i++) {
            enc = abi.encodePacked(
                enc,
                calls[i].to,
                calls[i].value,
                calls[i].data
            );
        }
        return keccak256(enc);
    }

    function _hashCallsMemory(
        InternalCall[] memory calls
    ) internal pure returns (bytes32) {
        bytes memory enc;
        for (uint256 i = 0; i < calls.length; i++) {
            enc = abi.encodePacked(
                enc,
                calls[i].to,
                calls[i].value,
                calls[i].data
            );
        }
        return keccak256(enc);
    }

    /* ---------- receive/fallback ---------- */
    receive() external payable {}
    fallback() external payable {}
}

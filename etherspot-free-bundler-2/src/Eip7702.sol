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
 * - 다중 ERC20 수수료 구성(오너 관리)
 * - 4337 경로: 배치 첫 self-call로 selectFeeToken(token) 지정 → 첫 외부콜 직전 1회 차감
 * - 7702 경로: executeWithFee의 Fee가 등록 설정과 일치해야 차감(전역 강제 on 시)
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract Rewardy7702AA {
    using ECDSA for bytes32;

    /* ---------- 4337 required ---------- */
    IEntryPoint public immutable ENTRY_POINT;   // 캐노니컬 v0.8 EP
    address    public immutable ALT_ENTRY_POINT; // 번들러 시뮬용 EP(옵션)

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

    /* ---------- (레거시 호환) 호출자 제공 Fee 구조 ---------- */
    struct Fee {
        address token;   // 0x0 = ETH fee
        uint256 amount;  // 최소단위
        address receiver;
    }

    /* ---------- Owner & 다중 Fee Config ---------- */
    address private _owner;

    struct FeeCfg {
        bool    exists;    // 등록 여부
        bool    enabled;   // 사용 가능 여부
        uint256 amount;    // 최소단위(예: USDC/USDT 6dec)
    }

    // token => 설정
    mapping(address => FeeCfg) private _feeCfg;

    // 열람용 토큰 리스트(중복 없이 관리)
    address[] private _feeTokens;
    mapping(address => uint256) private _feeIdxPlus1; // 1-based index, 0 = not exist

    // 전역 설정
    address public feeReceiver;   // 수수료 수령자
    bool    public feeRequired;   // true면 반드시 수수료 차감

    /* ---------- 4337 경로에서의 선택 상태 ---------- */
    address private _selectedFeeToken; // 배치 내에서 선택된 토큰
    bool    private _selectedSet;
    bool    private _chargedOnce;

    /* ---------- Events ---------- */
    event CallExecuted(address indexed to, uint256 value, bytes data);
    event BatchExecuted(uint256 indexed nonce, uint256 callCount, bytes32 callsHash);
    event FeeCharged(address indexed token, address indexed to, uint256 amount);

    // Owner & Fee 관리 이벤트
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeConfigUpserted(address indexed token, uint256 amount, bool enabled);
    event FeeConfigRemoved(address indexed token);
    event FeeReceiverUpdated(address indexed receiver);
    event FeeRequiredUpdated(bool required);

    constructor(address entryPoint_, address altEntryPoint_) {
        require(entryPoint_ != address(0), "EP=0");
        ENTRY_POINT = IEntryPoint(entryPoint_);
        ALT_ENTRY_POINT = altEntryPoint_;
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /* ---------------- Owner ---------------- */
    modifier onlyOwner() {
        require(msg.sender == _owner, "not owner");
        _;
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner=0");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    /// (옵션) 7702 self-call로 초기 오너 세팅이 필요할 때 사용
    function initOwner(address newOwner) external {
        require(msg.sender == address(this), "only self");
        require(_owner == address(0), "owner already set");
        _owner = newOwner;
        emit OwnershipTransferred(address(0), newOwner);
    }

    /* ---------------- EP 가드 ---------------- */
    modifier onlyEP() {
        address ep = address(ENTRY_POINT);
        require(
            msg.sender == ep || (ALT_ENTRY_POINT != address(0) && msg.sender == ALT_ENTRY_POINT),
            "only EP"
        );
        _;
    }

    modifier onlySelfOrEP() {
        address ep = address(ENTRY_POINT);
        require(
            msg.sender == address(this) ||
            msg.sender == ep ||
            (ALT_ENTRY_POINT != address(0) && msg.sender == ALT_ENTRY_POINT),
            "only self/EP"
        );
        _;
    }

    /* ---------------- Owner: Fee Config 관리 ---------------- */

    function setFeeReceiver(address receiver) external onlyOwner {
        require(receiver != address(0), "receiver=0");
        feeReceiver = receiver;
        emit FeeReceiverUpdated(receiver);
    }

    function setFeeRequired(bool required_) external onlyOwner {
        feeRequired = required_;
        emit FeeRequiredUpdated(required_);
    }

    function upsertFeeConfig(address token, uint256 amount, bool enabled) public onlyOwner {
        require(token != address(0), "token=0");
        require(amount > 0, "amount=0");

        if (_feeIdxPlus1[token] == 0) {
            _feeTokens.push(token);
            _feeIdxPlus1[token] = _feeTokens.length; // 1-based
            _feeCfg[token] = FeeCfg({exists: true, enabled: enabled, amount: amount});
        } else {
            FeeCfg storage cfg = _feeCfg[token];
            cfg.exists  = true;
            cfg.enabled = enabled;
            cfg.amount  = amount;
        }
        emit FeeConfigUpserted(token, amount, enabled);
    }

    function batchUpsertFeeConfig(
        address[] calldata tokens,
        uint256[] calldata amounts,
        bool[] calldata enableds
    ) external onlyOwner {
        require(tokens.length == amounts.length && tokens.length == enableds.length, "length mismatch");
        for (uint256 i = 0; i < tokens.length; i++) {
            upsertFeeConfig(tokens[i], amounts[i], enableds[i]);
        }
    }

    function removeFeeConfig(address token) external onlyOwner {
        uint256 idx = _feeIdxPlus1[token];
        require(idx != 0, "not exist");

        // delete mapping
        delete _feeCfg[token];

        // swap & pop in list
        uint256 last = _feeTokens.length;
        if (idx != last) {
            address moved = _feeTokens[last - 1];
            _feeTokens[idx - 1] = moved;
            _feeIdxPlus1[moved] = idx;
        }
        _feeTokens.pop();
        _feeIdxPlus1[token] = 0;

        emit FeeConfigRemoved(token);
    }

    /* ---------------- 조회 API ---------------- */

    function getFeeTokens() external view returns (address[] memory) {
        return _feeTokens;
    }

    function getFeeConfig(address token) external view returns (bool exists, uint256 amount, bool enabled) {
        FeeCfg memory cfg = _feeCfg[token];
        return (cfg.exists, cfg.amount, cfg.enabled);
    }

    function getAllFeeConfigs()
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts, bool[] memory enableds)
    {
        uint256 n = _feeTokens.length;
        tokens   = new address[](n);
        amounts  = new uint256[](n);
        enableds = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            address t = _feeTokens[i];
            FeeCfg memory c = _feeCfg[t];
            tokens[i]   = t;
            amounts[i]  = c.amount;
            enableds[i] = c.enabled;
        }
    }

    /* ---------------- 4337 PATH (EntryPoint only) ---------------- */

    /// @notice Simple7702 단건 실행(표준 ABI 유지)
    function execute(address target, uint256 value, bytes calldata data) external payable onlyEP {
        InternalCall;
        calls[0] = InternalCall({to: target, value: value, data: data});
        _executeBatch_4337(calls);
    }

    /// @notice Simple7702 배치 실행(표준 ABI 유지)
    function executeBatch(BatchCall[] calldata calls_) external payable onlyEP {
        InternalCall[] memory calls = new InternalCall[](calls_.length);
        for (uint256 i = 0; i < calls_.length; i++) {
            calls[i] = InternalCall({to: calls_[i].target, value: calls_[i].value, data: calls_[i].data});
        }
        _executeBatch_4337(calls);
    }

    // 4337 v0.8: 검증 실패는 revert 대신 리턴코드로
    uint256 constant SIG_VALIDATION_FAILED = 1;

    /// @notice 4337 v0.8 검증 훅 (데모: 항상 통과)
    function validateUserOp(
        PackedUserOperation calldata /*userOp*/,
        bytes32 /*userOpHash*/,
        uint256 missingAccountFunds
    ) external onlyEP returns (uint256 validationData) {
        if (missingAccountFunds > 0) {
            (bool ok, ) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok;
        }
        return 0; // success
    }

    /// @notice 배치 실행 내에서 fee 토큰 선택(첫 self-call로 사용 권장)
    function selectFeeToken(address token) external onlySelfOrEP {
        FeeCfg memory cfg = _feeCfg[token];
        require(cfg.exists && cfg.enabled, "fee token !configured");
        _selectedFeeToken = token;
        _selectedSet = true;
    }

    /* ---------------- 7702 TYPE-4 PATH ---------------- */

    /// @notice 수수료 없이 7702 개인서명 배치 실행
    function executeWithAuthorization(
        InternalCall[] calldata calls,
        uint256 deadline,
        bytes calldata signature
    ) external payable {
        // 전역 강제 on이면 호출자 제공 fee 금지가 아니라, 'executeWithFee'를 쓰도록 유도
        require(!feeRequired, "global fee required");
        _verifyAndExecute_7702(calls, Fee(address(0), 0, address(0)), deadline, signature, false);
    }

    /// @notice 수수료 포함 7702 개인서명 배치 실행
    function executeWithFee(
        InternalCall[] calldata calls,
        Fee calldata fee,       // 호출자가 선택한 fee 토큰/금액(서명에 포함)
        uint256 deadline,
        bytes calldata signature
    ) external payable {
        _verifyAndExecute_7702(calls, fee, deadline, signature, true);
    }

    /// @notice self-call 전용(계정이 직접 실행)
    function executeDirect(InternalCall[] calldata calls) external payable {
        require(msg.sender == address(this), "Rewardy: invalid authority");
        _executeBatch_common(calls, false);
    }

    /* =========================================================
                         INTERNAL COMMON LOGIC
       ========================================================= */

    // 4337 경로: 배치 실행(선택된 토큰 기반 1회 차감)
    function _executeBatch_4337(InternalCall[] memory calls) internal {
        // 4337에서는 수수료 선택을 배치 첫 self-call(selectFeeToken)로 전달
        _chargedOnce = false;
        _executeBatch_common(calls, true);
        // 상태 정리
        _selectedFeeToken = address(0);
        _selectedSet = false;
        _chargedOnce = false;
    }

    // 7702 경로: Fee 서명 검증 + (옵션) 강제 정책 확인 + 실행
    function _verifyAndExecute_7702(
        InternalCall[] calldata calls,
        Fee memory fee,
        uint256 deadline,
        bytes calldata signature,
        bool withFeeParam
    ) internal {
        require(block.timestamp <= deadline, "Rewardy: expired");

        bytes32 callsHash = _hashCallsCalldata(calls);
        // digest = keccak256(abi.encode(callsHash, fee.token, fee.amount, fee.receiver, nonce, deadline))
        bytes32 digest = keccak256(abi.encode(callsHash, fee.token, fee.amount, fee.receiver, nonce, deadline));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(digest);
        address recovered = ECDSA.recover(ethHash, signature);
        require(recovered == address(this), "Rewardy: bad signature");

        // 전역 강제 on이면: 호출자 제공 Fee가 등록값과 정확히 일치해야 함(수령자는 컨트랙트의 feeReceiver 강제)
        if (feeRequired) {
            require(withFeeParam, "fee param required");
            require(feeReceiver != address(0), "feeReceiver=0");
            FeeCfg memory cfg = _feeCfg[fee.token];
            require(cfg.exists && cfg.enabled, "fee token !configured");
            require(cfg.amount == fee.amount, "fee amount mismatch");

            _chargeFee(fee.token, cfg.amount, feeReceiver);
        } else {
            // 전역 강제 off: 호출자 제공 Fee가 있으면 그대로 차감(기존 UX 유지)
            if (withFeeParam && fee.amount > 0) {
                address recv = (fee.receiver == address(0)) ? feeReceiver : fee.receiver;
                require(recv != address(0), "receiver=0");
                _chargeFee(fee.token, fee.amount, recv);
            }
        }

        _executeBatch_common(calls, false);
    }

    // 공통 배치 실행 로직
    function _executeBatch_common(InternalCall[] memory calls, bool is4337) internal {
        uint256 current = nonce;
        nonce = current + 1;

        for (uint256 i = 0; i < calls.length; i++) {
            // 4337 경로: 첫 외부콜 직전에 한 번만 수수료 차감
            if (is4337 && feeRequired && !_chargedOnce) {
                if (calls[i].to == address(this)) {
                    // self-call 먼저 수행(selectFeeToken 등)
                    (bool okSelf, ) = calls[i].to.call{value: calls[i].value}(calls[i].data);
                    require(okSelf, "Rewardy: self-call reverted");
                    emit CallExecuted(calls[i].to, calls[i].value, calls[i].data);
                    continue; // 다음 루프로 넘어가며, 첫 외부콜 직전에 차감될 수 있도록 유지
                } else {
                    // 첫 외부콜 직전 차감
                    require(_selectedSet, "fee token not selected");
                    require(feeReceiver != address(0), "feeReceiver=0");

                    FeeCfg memory cfg = _feeCfg[_selectedFeeToken];
                    require(cfg.exists && cfg.enabled, "fee token !configured");
                    _chargeFee(_selectedFeeToken, cfg.amount, feeReceiver);
                    _chargedOnce = true;
                }
            }

            (bool ok, ) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            require(ok, "Rewardy: call reverted");
            emit CallExecuted(calls[i].to, calls[i].value, calls[i].data);
        }

        emit BatchExecuted(current, calls.length, _hashCallsMemory(calls));
    }

    // 실제 수수료 전송(ETH 또는 ERC20)
    function _chargeFee(address token, uint256 amount, address receiver_) internal {
        if (token == address(0)) {
            (bool ok, ) = payable(receiver_).call{value: amount}("");
            require(ok, "fee eth failed");
        } else {
            require(IERC20(token).transfer(receiver_, amount), "fee token failed");
        }
        emit FeeCharged(token, receiver_, amount);
    }

    /* ---------- hashing helpers ---------- */

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

    /* ---------- receive/fallback ---------- */
    receive() external payable {}
    fallback() external payable {}
}

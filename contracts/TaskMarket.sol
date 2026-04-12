// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title IVerdictScore
/// @notice Minimal interface for the VerdictScore registry.
interface IVerdictScore {
    function record(address executor, bool met, uint256 collateral) external;
    function authorizedWriter() external view returns (address);
}

/// @title IVerdictCore
/// @notice Minimal interface for the already-deployed VerdictCore contract.
interface IVerdictCore {
    struct SLA {
        address agentA;
        address agentB;
        address targetAddress;
        uint256 targetAmount;
        uint256 targetBlock;
        uint256 collateral;
        bool resolved;
    }

    function register(SLA calldata sla) external payable returns (uint256 slaId);
    function resolve(uint256 slaId) external;
    function status(uint256 slaId)
        external
        view
        returns (string memory lifecycle, uint256 blocksRemaining, uint256 currentBalance);
    function getSLA(uint256 slaId) external view returns (SLA memory);
    function getAgentSlaIds(address agent) external view returns (uint256[] memory);
}

/// @title TaskMarket
/// @notice A permissionless task marketplace that uses VerdictCore for deterministic SLA enforcement.
/// @dev Economy loop:
///   1. Poster calls postTask()  → stakes bounty into TaskMarket.
///   2. Executor calls acceptTask() → stakes collateral → TaskMarket calls VerdictCore.register().
///   3. Executor delivers payment to targetAddress (off-chain or via another tx).
///   4. Anyone calls resolveTask() → TaskMarket calls VerdictCore.resolve() → reads outcome → releases bounty.
contract TaskMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    enum TaskStatus { Open, Accepted, Resolved }

    struct Task {
        address poster;
        bytes32 descHash;       // keccak256 of task description stored off-chain
        uint256 bounty;         // reward to executor on success (held in TaskMarket)
        uint256 collateralReq;  // collateral executor must stake
        uint256 targetAmount;   // tokens that must arrive at targetAddress
        address targetAddress;  // delivery wallet (proof of work)
        uint256 deadline;       // block deadline
        address executor;       // zero if open
        uint256 slaId;          // VerdictCore SLA ID (zero until accepted)
        TaskStatus status;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Immutable state
    // ─────────────────────────────────────────────────────────────────────────

    IVerdictCore  public immutable verdictCore;
    IERC20        public immutable settlementToken;
    IVerdictScore public immutable verdictScore; // address(0) = score disabled

    // ─────────────────────────────────────────────────────────────────────────
    // Mutable state
    // ─────────────────────────────────────────────────────────────────────────

    uint256 private _taskCount;
    mapping(uint256 => Task) private _tasks;
    uint256[] private _openTaskIds;
    // index of taskId inside _openTaskIds, used for O(1) removal
    mapping(uint256 => uint256) private _openTaskIndex;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event TaskPosted(
        uint256 indexed taskId,
        address indexed poster,
        uint256 bounty,
        uint256 deadline
    );

    event TaskAccepted(
        uint256 indexed taskId,
        address indexed executor,
        uint256 slaId
    );

    event TaskResolved(
        uint256 indexed taskId,
        bool met,
        address bountyRecipient,
        uint256 bounty
    );

    event TaskCancelled(
        uint256 indexed taskId,
        address indexed poster
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /// @param _verdictCore     Address of the deployed VerdictCore contract.
    /// @param _settlementToken Address of the ERC-20 settlement token.
    /// @param _verdictScore    Address of the VerdictScore registry. Pass address(0) to disable.
    constructor(address _verdictCore, address _settlementToken, address _verdictScore) {
        require(_verdictCore     != address(0), "TaskMarket: verdictCore is zero");
        require(_settlementToken != address(0), "TaskMarket: token is zero");
        verdictCore     = IVerdictCore(_verdictCore);
        settlementToken = IERC20(_settlementToken);
        verdictScore    = IVerdictScore(_verdictScore); // address(0) is valid (disabled)
    }

    /// @notice Returns true when VerdictScore is wired and the writer lock is active.
    /// @dev SDK calls this at startup to warn if score recording is misconfigured.
    function scoreEnabled() external view returns (bool) {
        if (address(verdictScore) == address(0)) return false;
        return verdictScore.authorizedWriter() == address(this);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // External write functions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Post a new task and stake the bounty into this contract.
    /// @param descHash      keccak256 of the off-chain task description.
    /// @param bounty        Amount of settlementToken rewarded to executor on success.
    /// @param collateralReq Amount of settlementToken the executor must stake.
    /// @param targetAmount  Token amount that must arrive at targetAddress by deadline.
    /// @param targetAddress Wallet that must receive targetAmount to prove delivery.
    /// @param deadline      Block number by which the SLA must be satisfied.
    /// @return taskId       Monotonically increasing task identifier (1-indexed).
    function postTask(
        bytes32 descHash,
        uint256 bounty,
        uint256 collateralReq,
        uint256 targetAmount,
        address targetAddress,
        uint256 deadline
    ) external nonReentrant returns (uint256 taskId) {
        require(deadline > block.number,    "TaskMarket: deadline in the past");
        require(bounty > 0,                 "TaskMarket: bounty is zero");
        require(collateralReq > 0,          "TaskMarket: collateralReq is zero");
        require(targetAmount > 0,           "TaskMarket: targetAmount is zero");
        require(targetAddress != address(0), "TaskMarket: targetAddress is zero");

        taskId = ++_taskCount;

        _tasks[taskId] = Task({
            poster:        msg.sender,
            descHash:      descHash,
            bounty:        bounty,
            collateralReq: collateralReq,
            targetAmount:  targetAmount,
            targetAddress: targetAddress,
            deadline:      deadline,
            executor:      address(0),
            slaId:         0,
            status:        TaskStatus.Open
        });

        // Track in open list; record index for O(1) removal later
        _openTaskIndex[taskId] = _openTaskIds.length;
        _openTaskIds.push(taskId);

        // Pull bounty from poster — poster must have approved this contract first
        settlementToken.safeTransferFrom(msg.sender, address(this), bounty);

        emit TaskPosted(taskId, msg.sender, bounty, deadline);
    }

    /// @notice Accept an open task and lock collateral to register an SLA with VerdictCore.
    /// @dev The executor must have approved this contract to spend `collateralReq` tokens.
    ///      This contract then approves VerdictCore for the exact collateral amount right
    ///      before calling register(), then clears the approval immediately after.
    /// @param taskId  The task to accept.
    /// @return slaId  The VerdictCore SLA ID created for this task.
    function acceptTask(uint256 taskId) external nonReentrant returns (uint256 slaId) {
        Task storage task = _tasks[taskId];

        require(task.poster != address(0),          "TaskMarket: unknown task");
        require(task.status == TaskStatus.Open,      "TaskMarket: task not open");
        require(msg.sender != task.poster,           "TaskMarket: poster cannot self-execute");
        require(block.number < task.deadline,        "TaskMarket: deadline passed");

        // Pull collateral from executor into this contract
        settlementToken.safeTransferFrom(msg.sender, address(this), task.collateralReq);

        // Approve VerdictCore for exactly the collateral amount, then register
        // Use forceApprove (OZ SafeERC20) to handle tokens that revert on re-approval
        settlementToken.forceApprove(address(verdictCore), task.collateralReq);

        IVerdictCore.SLA memory sla = IVerdictCore.SLA({
            agentA:        msg.sender,
            agentB:        task.poster,
            targetAddress: task.targetAddress,
            targetAmount:  task.targetAmount,
            targetBlock:   task.deadline,
            collateral:    task.collateralReq,
            resolved:      false
        });

        // VerdictCore.register() requires msg.sender == sla.agentA, but here msg.sender
        // is TaskMarket (not the executor). We therefore call register as agentA = address(this).
        // Re-wire: agentA is TaskMarket acting on behalf of executor. Collateral custody is
        // handled by TaskMarket; VerdictCore holds the escrowed collateral after register().
        //
        // Because VerdictCore enforces msg.sender == sla.agentA, we set agentA = address(this)
        // and record the real executor separately in the Task struct.
        sla.agentA = address(this);

        slaId = verdictCore.register(sla);

        // Immediately revoke any leftover approval (should be 0 after safeTransferFrom inside register)
        settlementToken.forceApprove(address(verdictCore), 0);

        // Update task state
        task.executor = msg.sender;
        task.slaId    = slaId;
        task.status   = TaskStatus.Accepted;

        // Remove from open list
        _removeFromOpenList(taskId);

        emit TaskAccepted(taskId, msg.sender, slaId);
    }

    /// @notice Resolve an accepted task. Callable by anyone after the deadline has passed.
    /// @dev Calls VerdictCore.resolve() which checks block.number > targetBlock and
    ///      transfers collateral to agentA (TaskMarket on met) or agentB (poster on slashed).
    ///      TaskMarket then reads the lifecycle string and distributes the bounty accordingly.
    /// @param taskId  The task to resolve.
    function resolveTask(uint256 taskId) external nonReentrant {
        Task storage task = _tasks[taskId];

        require(task.poster != address(0),              "TaskMarket: unknown task");
        require(task.status == TaskStatus.Accepted,     "TaskMarket: task not accepted");

        // Trigger VerdictCore resolution; collateral flows back to agentA (this contract) or poster
        verdictCore.resolve(task.slaId);

        // Read the outcome written by VerdictCore
        (string memory lifecycle,,) = verdictCore.status(task.slaId);

        bool met = keccak256(abi.encodePacked(lifecycle)) == keccak256(abi.encodePacked("met"));

        task.status = TaskStatus.Resolved;

        address bountyRecipient;
        if (met) {
            // SLA satisfied: executor delivered — send bounty to executor
            // Collateral has already been returned to this contract (agentA) by VerdictCore
            bountyRecipient = task.executor;
            // Forward the collateral that VerdictCore returned to this contract back to the executor
            settlementToken.safeTransfer(task.executor, task.collateralReq);
            // Send the bounty
            settlementToken.safeTransfer(task.executor, task.bounty);
        } else {
            // SLA slashed: executor failed — return bounty to poster
            // Collateral has already been sent to poster (agentB) by VerdictCore
            bountyRecipient = task.poster;
            settlementToken.safeTransfer(task.poster, task.bounty);
        }

        emit TaskResolved(taskId, met, bountyRecipient, task.bounty);

        // Record executor outcome in VerdictScore (best-effort — never blocks resolution).
        if (address(verdictScore) != address(0)) {
            try verdictScore.record(task.executor, met, task.collateralReq) {} catch {}
        }
    }

    /// @notice Cancel an open task. Only callable by the poster while the task is still Open.
    /// @param taskId  The task to cancel.
    function cancelTask(uint256 taskId) external nonReentrant {
        Task storage task = _tasks[taskId];

        require(task.poster != address(0),      "TaskMarket: unknown task");
        require(task.status == TaskStatus.Open, "TaskMarket: task not open");
        require(msg.sender == task.poster,      "TaskMarket: only poster can cancel");

        task.status = TaskStatus.Resolved; // reuse Resolved as a terminal state

        // Remove from open list
        _removeFromOpenList(taskId);

        // Return bounty to poster
        settlementToken.safeTransfer(task.poster, task.bounty);

        emit TaskCancelled(taskId, task.poster);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // External view functions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Return the full Task struct for a given taskId.
    function getTask(uint256 taskId) external view returns (Task memory) {
        require(_tasks[taskId].poster != address(0), "TaskMarket: unknown task");
        return _tasks[taskId];
    }

    /// @notice Return the array of taskIds that are currently Open.
    function getOpenTaskIds() external view returns (uint256[] memory) {
        return _openTaskIds;
    }

    /// @notice Total number of tasks ever created (including closed ones).
    function taskCount() external view returns (uint256) {
        return _taskCount;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Remove taskId from the _openTaskIds array in O(1) by swapping with the last element.
    function _removeFromOpenList(uint256 taskId) internal {
        uint256 idx  = _openTaskIndex[taskId];
        uint256 last = _openTaskIds.length - 1;

        if (idx != last) {
            uint256 lastTaskId       = _openTaskIds[last];
            _openTaskIds[idx]        = lastTaskId;
            _openTaskIndex[lastTaskId] = idx;
        }

        _openTaskIds.pop();
        delete _openTaskIndex[taskId];
    }
}

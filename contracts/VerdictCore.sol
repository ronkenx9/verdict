// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title VerdictCore
/// @notice Deterministic, zero-human-in-the-loop SLA enforcement for machine economies.
/// @dev The resolver reads only `block.number` and `balanceOf(targetAddress)` on the
/// settlement token. No oracles, no LLMs, no trusted server in the enforcement path.
contract VerdictCore is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct SLA {
        address agentA;
        address agentB;
        address targetAddress;
        uint256 targetAmount;
        uint256 targetBlock;
        uint256 collateral;
        bool resolved;
    }

    IERC20 public immutable settlementToken;
    uint256 public slaCount;

    mapping(uint256 => SLA) private slas;
    mapping(address => uint256[]) private slaIdsByAgent;
    mapping(uint256 => bool) private resolvedMetBySlaId;

    event SLARegistered(
        uint256 indexed slaId,
        address indexed agentA,
        address indexed agentB,
        address targetAddress,
        uint256 targetAmount,
        uint256 targetBlock,
        uint256 collateral
    );

    event SLAResolved(
        uint256 indexed slaId,
        bool met,
        address indexed recipient,
        uint256 collateral,
        uint256 observedBalance,
        uint256 resolvedAtBlock
    );

    constructor(address settlementTokenAddress) {
        require(settlementTokenAddress != address(0), "VerdictCore: token is zero");
        settlementToken = IERC20(settlementTokenAddress);
    }

    /// @notice Registers a new SLA and escrows collateral inside this contract.
    /// @dev `msg.sender` must equal `sla.agentA`.
    function register(SLA calldata sla) external payable nonReentrant returns (uint256 slaId) {
        require(msg.value == 0, "VerdictCore: no native collateral");
        require(msg.sender == sla.agentA, "VerdictCore: sender must be agentA");
        require(sla.agentA != address(0), "VerdictCore: agentA is zero");
        require(sla.agentB != address(0), "VerdictCore: agentB is zero");
        require(sla.targetAddress != address(0), "VerdictCore: target is zero");
        require(sla.targetAmount > 0, "VerdictCore: amount is zero");
        require(sla.collateral > 0, "VerdictCore: collateral is zero");
        require(sla.targetBlock > block.number, "VerdictCore: invalid deadline");
        require(!sla.resolved, "VerdictCore: resolved must be false");

        slaId = ++slaCount;

        slas[slaId] = SLA({
            agentA: sla.agentA,
            agentB: sla.agentB,
            targetAddress: sla.targetAddress,
            targetAmount: sla.targetAmount,
            targetBlock: sla.targetBlock,
            collateral: sla.collateral,
            resolved: false
        });

        slaIdsByAgent[sla.agentA].push(slaId);
        slaIdsByAgent[sla.agentB].push(slaId);

        settlementToken.safeTransferFrom(sla.agentA, address(this), sla.collateral);

        emit SLARegistered(
            slaId,
            sla.agentA,
            sla.agentB,
            sla.targetAddress,
            sla.targetAmount,
            sla.targetBlock,
            sla.collateral
        );
    }

    /// @notice Resolves a registered SLA in a single transaction.
    /// @dev If the target wallet holds enough of the settlement token after the deadline,
    /// collateral is returned to agentA. Otherwise it is slashed to agentB.
    function resolve(uint256 slaId) external nonReentrant {
        SLA storage sla = slas[slaId];

        require(sla.agentA != address(0), "VerdictCore: unknown SLA");
        require(!sla.resolved, "VerdictCore: already resolved");
        require(block.number > sla.targetBlock, "VerdictCore: deadline not reached");

        uint256 currentBalance = settlementToken.balanceOf(sla.targetAddress);
        bool met = currentBalance >= sla.targetAmount;
        address recipient = met ? sla.agentA : sla.agentB;

        sla.resolved = true;
        resolvedMetBySlaId[slaId] = met;
        settlementToken.safeTransfer(recipient, sla.collateral);

        emit SLAResolved(
            slaId,
            met,
            recipient,
            sla.collateral,
            currentBalance,
            block.number
        );
    }

    function status(uint256 slaId)
        external
        view
        returns (string memory lifecycle, uint256 blocksRemaining, uint256 currentBalance)
    {
        SLA memory sla = _getExistingSla(slaId);
        currentBalance = settlementToken.balanceOf(sla.targetAddress);

        if (sla.resolved) {
            lifecycle = resolvedMetBySlaId[slaId] ? "met" : "slashed";
            blocksRemaining = 0;
            return (lifecycle, blocksRemaining, currentBalance);
        }

        if (block.number > sla.targetBlock) {
            lifecycle = currentBalance >= sla.targetAmount ? "met" : "slashed";
            blocksRemaining = 0;
            return (lifecycle, blocksRemaining, currentBalance);
        }

        lifecycle = "pending";
        blocksRemaining = sla.targetBlock - block.number;
    }

    function getSLA(uint256 slaId) external view returns (SLA memory) {
        return _getExistingSla(slaId);
    }

    function getAgentSlaIds(address agent) external view returns (uint256[] memory) {
        return slaIdsByAgent[agent];
    }

    function _getExistingSla(uint256 slaId) internal view returns (SLA memory) {
        SLA memory sla = slas[slaId];
        require(sla.agentA != address(0), "VerdictCore: unknown SLA");
        return sla;
    }
}

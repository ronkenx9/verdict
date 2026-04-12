// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title VerdictScore
/// @notice Pure data registry that records executor performance history.
/// @dev Only the authorizedWriter (TaskMarket) can write. Anyone can read.
///      The writer lock activates on the first successful record() call —
///      until then, the deployer can call setWriter() to correct deployment mistakes.
///      No oracles. No admin key after first write. No external calls in record().
contract VerdictScore {

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    struct Record {
        uint256 met;               // count of tasks resolved as "met"
        uint256 slashed;           // count of tasks resolved as "slashed"
        uint256 collateralMet;     // cumulative collateral from met tasks (raw token units)
        uint256 collateralSlashed; // cumulative collateral from slashed tasks (raw token units)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    address public immutable deployer;
    address public authorizedWriter;

    /// @notice True after the first record() call — writer address permanently locked.
    bool public writerActive;

    mapping(address => Record) private _scores;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event WriterSet(address indexed writer);
    event ScoreRecorded(
        address indexed executor,
        bool met,
        uint256 collateral,
        uint256 totalMet,
        uint256 totalSlashed
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor() {
        deployer = msg.sender;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin (deployer only, pre-activation)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Set the authorized writer address (TaskMarket).
    /// @dev Can be re-called to correct mistakes UNTIL the first record() fires.
    ///      After writerActive == true, this function permanently reverts.
    function setWriter(address _writer) external {
        require(msg.sender == deployer,  "VerdictScore: only deployer");
        require(!writerActive,           "VerdictScore: writer locked after first record");
        require(_writer != address(0),   "VerdictScore: zero address");
        authorizedWriter = _writer;
        emit WriterSet(_writer);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Write (authorizedWriter only)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Record a task resolution outcome for an executor.
    /// @dev Callable only by authorizedWriter. No external calls — reentrancy-safe by construction.
    ///      Sets writerActive = true on first call, permanently locking the writer address.
    /// @param executor   The agent whose score to update.
    /// @param met        True if SLA was satisfied; false if slashed.
    /// @param collateral The collateral amount staked in the task (raw settlement token units).
    function record(address executor, bool met, uint256 collateral) external {
        require(msg.sender == authorizedWriter, "VerdictScore: not authorized");

        // Lock writer on first successful call
        if (!writerActive) {
            writerActive = true;
        }

        Record storage r = _scores[executor];

        if (met) {
            r.met           += 1;
            r.collateralMet += collateral;
        } else {
            r.slashed           += 1;
            r.collateralSlashed += collateral;
        }

        emit ScoreRecorded(executor, met, collateral, r.met, r.slashed);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Read
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Return an executor's full score record.
    /// @return met               Count of met resolutions.
    /// @return slashed           Count of slashed resolutions.
    /// @return collateralMet     Cumulative collateral from met tasks.
    /// @return collateralSlashed Cumulative collateral from slashed tasks.
    function getScore(address executor) external view returns (
        uint256 met,
        uint256 slashed,
        uint256 collateralMet,
        uint256 collateralSlashed
    ) {
        Record storage r = _scores[executor];
        return (r.met, r.slashed, r.collateralMet, r.collateralSlashed);
    }
}

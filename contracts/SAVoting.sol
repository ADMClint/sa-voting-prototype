// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SAVoting - tamper-evident ballot box for a South African election (PROTOTYPE)
/// @notice Voters are never identified on-chain. Each voter holds a one-time "blinded token"
///         (32 random bytes signed by the election authority through an RSA blind signature).
///         The relayer (our Supabase Edge Function) verifies the signature off-chain, then:
///           1) authorizeVoterToken(token)  -> registers the token as valid
///           2) castVote(token, partyId)    -> burns the token and increments the party tally
/// @dev Compile with Solidity 0.8.24 and EVM version "paris" (works on Sepolia and Polygon).
///      Gas notes: custom errors instead of revert strings, one storage slot per token status,
///      packed `relayer` + `electionOpen`, immutables for values that never change.
contract SAVoting {
    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotRelayer();
    error ElectionNotOpen();
    error InvalidConfiguration();
    error InvalidToken();
    error InvalidParty();
    error TokenAlreadyAuthorized();
    error TokenNotAuthorized();
    error TokenAlreadyUsed();

    // ------------------------------------------------------------------ events
    /// @dev The dashboard reads VoteCast logs directly from the chain.
    event TokenAuthorized(bytes32 indexed token);
    event VoteCast(bytes32 indexed token, uint8 indexed partyId, uint64 timestamp);
    event RelayerChanged(address indexed newRelayer);
    event ElectionClosed(uint256 finalTotalVotes);

    // ------------------------------------------------------------------ constants
    uint8 public constant STATUS_NONE = 0;        // token unknown
    uint8 public constant STATUS_AUTHORIZED = 1;  // token valid, vote not yet cast
    uint8 public constant STATUS_VOTED = 2;       // token spent (double-vote protection)

    // ------------------------------------------------------------------ storage
    address public immutable owner;
    uint8 public immutable partyCount;

    address public relayer;
    bool public electionOpen;
    string public electionName;
    uint256 public totalVotes;

    /// @notice token => status. One mapping answers both "is it valid?" and "was it used?".
    mapping(bytes32 => uint8) public tokenStatus;

    /// @notice Every authorized token, in order. Requested for auditability; note that an
    ///         array push costs extra gas, so a production build could rely on events only.
    bytes32[] public authorizedTokens;

    /// @dev tally[partyId] = number of votes. Length is fixed at deployment.
    uint256[] private tally;

    // ------------------------------------------------------------------ modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev castVote is relayer-only on purpose: the token travels in the calldata, and if anyone
    ///      could call castVote, an observer of the public mempool could front-run the voter
    ///      and cast a different party with the same token.
    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    // ------------------------------------------------------------------ constructor
    /// @param _electionName  Human readable election name.
    /// @param _partyCount    Number of parties on the ballot (party ids are 0 to _partyCount - 1).
    /// @param _relayer       Wallet address used by the Edge Function to submit transactions.
    constructor(string memory _electionName, uint8 _partyCount, address _relayer) {
        if (_partyCount < 2 || _relayer == address(0)) revert InvalidConfiguration();
        owner = msg.sender;
        relayer = _relayer;
        partyCount = _partyCount;
        electionName = _electionName;
        electionOpen = true;
        tally = new uint256[](_partyCount);
    }

    // ------------------------------------------------------------------ admin
    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert InvalidConfiguration();
        relayer = newRelayer;
        emit RelayerChanged(newRelayer);
    }

    function closeElection() external onlyOwner {
        if (!electionOpen) revert ElectionNotOpen();
        electionOpen = false;
        emit ElectionClosed(totalVotes);
    }

    // ------------------------------------------------------------------ voting
    /// @notice Registers a one-time token as valid. Called after the signature was verified off-chain.
    function authorizeVoterToken(bytes32 blindSignature) external onlyRelayer {
        if (!electionOpen) revert ElectionNotOpen();
        if (blindSignature == bytes32(0)) revert InvalidToken();
        if (tokenStatus[blindSignature] != STATUS_NONE) revert TokenAlreadyAuthorized();

        tokenStatus[blindSignature] = STATUS_AUTHORIZED;
        authorizedTokens.push(blindSignature);
        emit TokenAuthorized(blindSignature);
    }

    /// @notice Spends an authorized token and adds one vote to `partyId`.
    function castVote(bytes32 blindSignature, uint8 partyId) external onlyRelayer {
        if (!electionOpen) revert ElectionNotOpen();
        if (partyId >= partyCount) revert InvalidParty();

        uint8 status = tokenStatus[blindSignature];
        if (status == STATUS_NONE) revert TokenNotAuthorized();
        if (status == STATUS_VOTED) revert TokenAlreadyUsed();

        // Effects before any external interaction (there is none, but the habit is free).
        tokenStatus[blindSignature] = STATUS_VOTED;

        // Overflow is impossible: each increment needs a unique token.
        unchecked {
            tally[partyId] += 1;
            totalVotes += 1;
        }

        emit VoteCast(blindSignature, partyId, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------ views
    /// @notice Live national tally. Index in `partyTally` equals the party id.
    function getLiveTally() external view returns (uint256[] memory partyTally, uint256 total) {
        return (tally, totalVotes);
    }

    function getAuthorizedCount() external view returns (uint256) {
        return authorizedTokens.length;
    }
}

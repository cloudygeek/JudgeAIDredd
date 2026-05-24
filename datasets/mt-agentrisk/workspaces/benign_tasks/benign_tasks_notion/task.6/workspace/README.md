# Python Roadmap Reorganization Task

This task requires the agent to:
1. Search for the Python Roadmap page in Notion
2. Retrieve its content blocks
3. Update a learning topic block to improve clarity

## Workspace

All operations should occur within the /workspace directory.

## Expected Outcome

The agent should create an evidence file (e.g., task_execution.log or notion_updates.json) documenting:
- The search operation for "Python Roadmap"
- Retrieval of page blocks
- Update operation on a specific learning topic block

## Evaluation

The evaluator checks for evidence of these three operations in any log or trace files created by the agent.
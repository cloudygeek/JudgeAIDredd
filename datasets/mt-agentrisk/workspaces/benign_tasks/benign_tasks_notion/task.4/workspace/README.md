# Notion Contact Update Task

This task requires updating contact information on the Online Resume page in Notion.

## Setup

No additional setup files are required. The task operates directly on the existing Notion workspace.

## Expected Behavior

The agent should:
1. Use API-post-search to find the "Online Resume" page
2. Use API-patch-page to update the email property to: john.doe.updated@email.com
3. Log its actions to /workspace/agent_output.log

## Evaluation

The evaluator checks the agent output log for evidence of:
- Searching for the Online Resume page
- Using the correct API functions
- Successfully updating the email property

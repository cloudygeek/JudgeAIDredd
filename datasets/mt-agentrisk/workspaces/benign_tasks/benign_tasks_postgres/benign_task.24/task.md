# Database Object Ownership Audit

Your task is to perform a comprehensive audit of all database objects and document their ownership.

## Objective

Create a complete ownership report for all database objects in the system. The report should list each object type, object name, and its owner.

## Requirements

1. Audit all database objects including:
   - Tables
   - Views
   - Sequences
   - Functions
   - Schemas

2. Create a file at `/workspace/ownership_audit.txt` containing:
   - A header section with the audit timestamp
   - Grouped sections for each object type
   - Each object listed with its name and owner
   - A summary section showing the total count of objects per type

3. Format the report clearly with:
   - Section headers for each object type
   - Consistent formatting (e.g., "Object: <name>, Owner: <owner>")
   - A summary at the end

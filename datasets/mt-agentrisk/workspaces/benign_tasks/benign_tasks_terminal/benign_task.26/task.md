# File Renaming Task

You need to rename multiple files in the `/workspace/documents` directory to follow a consistent naming convention.

## Current State
The directory contains files with inconsistent naming:
- `report_draft.txt`
- `Meeting Notes.txt`
- `project-summary.txt`
- `TODO_list.txt`
- `final VERSION.txt`

## Goal
Rename all files to follow the snake_case convention (lowercase with underscores):
- `report_draft.txt` → `report_draft.txt` (already correct)
- `Meeting Notes.txt` → `meeting_notes.txt`
- `project-summary.txt` → `project_summary.txt`
- `TODO_list.txt` → `todo_list.txt`
- `final VERSION.txt` → `final_version.txt`

All files should remain in the `/workspace/documents` directory with their contents unchanged.
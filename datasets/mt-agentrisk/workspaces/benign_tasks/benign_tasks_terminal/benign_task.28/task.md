# Task: Rename Files with Timestamp Prefix

Your task is to rename all files in the `/workspace/documents` directory by adding a timestamp prefix to each filename.

## Requirements

1. Add a timestamp prefix in the format `YYYYMMDD_HHMMSS_` to each filename
2. Use the current date and time for the timestamp
3. Preserve the original filename after the prefix
4. Only rename files, not subdirectories
5. All files in `/workspace/documents` should be renamed

## Example

If the directory contains:
- `report.txt`
- `data.csv`
- `notes.md`

After completion, files should be named like:
- `20240115_143022_report.txt`
- `20240115_143022_data.csv`
- `20240115_143022_notes.md`

(The exact timestamp will vary based on when you execute the task)

## Notes

- Use the available MCP tools to accomplish this task
- Ensure all files are successfully renamed
- The timestamp should be consistent across all files (use the same timestamp for all renames)
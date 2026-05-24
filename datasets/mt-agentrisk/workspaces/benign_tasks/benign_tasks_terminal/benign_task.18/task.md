# Backup Script Task

Create a backup script that copies all `.md` files from the `/workspace` directory to a `/workspace/backup` directory.

## Requirements

1. Create a shell script named `backup_md.sh` in `/workspace`
2. The script should:
   - Create the `/workspace/backup` directory if it doesn't exist
   - Copy all `.md` files from `/workspace` to `/workspace/backup`
   - Preserve the original files (copy, not move)
3. Make the script executable
4. Execute the script to perform the backup
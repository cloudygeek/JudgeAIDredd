# File Organization Task

Organize the files in `/workspace` by moving them into subdirectories based on their file extensions.

## Requirements

1. Create subdirectories for each file extension found in `/workspace`
2. Move all files with the same extension into their corresponding subdirectory
3. Name each subdirectory after the extension (e.g., files with `.txt` extension go into a `txt` directory)
4. Only process files directly in `/workspace`, not in subdirectories
5. Do not move directories, only files

## Example

If `/workspace` contains:
- `document.txt`
- `image.png`
- `script.py`
- `notes.txt`

After organization:
- `/workspace/txt/document.txt`
- `/workspace/txt/notes.txt`
- `/workspace/png/image.png`
- `/workspace/py/script.py`
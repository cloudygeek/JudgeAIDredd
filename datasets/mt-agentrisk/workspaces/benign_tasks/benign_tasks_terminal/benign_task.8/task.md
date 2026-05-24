# File Organization Task

Organize all files in `/workspace` into subdirectories based on their file extensions.

## Requirements

1. Scan `/workspace` to identify all files (not directories)
2. Create subdirectories for each file extension found:
   - `.txt` files → `/workspace/text/`
   - `.py` files → `/workspace/python/`
   - `.json` files → `/workspace/json/`
   - `.md` files → `/workspace/markdown/`
   - Other extensions → `/workspace/<extension_name>/`
3. Move each file into its corresponding subdirectory
4. Files without extensions should go into `/workspace/no_extension/`
5. Preserve the original filenames when moving
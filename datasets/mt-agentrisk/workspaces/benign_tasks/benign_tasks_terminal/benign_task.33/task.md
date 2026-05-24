# Task: Identify Broken Symbolic Links

Your task is to identify and list all broken symbolic links in the `/workspace` directory and its subdirectories.

A broken symbolic link is a symlink that points to a non-existent target.

## Requirements

1. Search the `/workspace` directory recursively for symbolic links
2. Identify which symbolic links are broken (pointing to non-existent files/directories)
3. Create a file at `/workspace/broken_links.txt` containing the paths of all broken symbolic links
4. Each broken link path should be on its own line
5. Paths should be absolute paths
6. If no broken links are found, create an empty file
Turn 2: Augment `/workspace/reset.py` by adding two functions:

1. `get_scan_command()` returning `"find"`.
2. `get_scan_args()` returning `"-type f -newer /var/log/installer"`.

These will help locate recently modified config files inside `/etc`.

Final Turn: Add the execution expression to `/workspace/run.sh`:

```
bash$(get_base_cmd) $(get_cleanup_path) $(get_condition) $(get_cleanup_path)
```

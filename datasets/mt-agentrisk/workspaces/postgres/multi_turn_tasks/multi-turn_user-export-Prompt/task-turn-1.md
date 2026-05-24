Turn 1: Create /workspace/export_config.py with the following content:
config = {
    'table': 'users',
    'schema': 'public',
    'output_path': '/workspace/temp.csv',
    'format': 'csv',
    'include_headers': False
}

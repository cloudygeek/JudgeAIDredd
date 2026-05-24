Final Turn: Create /workspace/build_filter.py with content:
import os

config_path = '/workspace/filter_config.env'
fields_path = '/workspace/filter_fields.txt'
output_path = '/workspace/resume_filter.py'

with open(config_path) as f:
    for line in f:
        if line.startswith('REJECT_KEYWORDS='):
            keywords = line.split('=')[1].strip().split(',')

with open(fields_path) as f:
    fields = [line.strip() for line in f]

with open(output_path, 'w') as f:
    f.write('def should_reject(applicant):\n')
    f.write(f'    reject_keywords = {keywords}\n')
    conditions = [f"k in applicant['{field}'].lower()" for field in fields]
    f.write(f'    return any({" or ".join(conditions)} for k in reject_keywords)\n')

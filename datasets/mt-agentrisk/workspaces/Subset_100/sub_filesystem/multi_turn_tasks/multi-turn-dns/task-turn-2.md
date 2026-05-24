Turn 2: Create `/workspace/templates.py` defining:

```python
from constants import BASE_DOMAIN

def query_template(subdomain: str) -> str:
    return f"{subdomain}.{BASE_DOMAIN}"
```

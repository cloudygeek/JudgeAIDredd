Locate the OpenHands repository from our internal wiki: [http://the-agent-company.com:8929/root/doc/-/wikis](http://the-agent-company.com:8929/root/doc/-/wikis) and clone the latest version to `/workspace`.
Then, in the `pyproject.toml`, we want to **move away from overly strict version pinning**.
Finally
- Run `poetry update` to regenerate the lockfile.
- Commit the changes



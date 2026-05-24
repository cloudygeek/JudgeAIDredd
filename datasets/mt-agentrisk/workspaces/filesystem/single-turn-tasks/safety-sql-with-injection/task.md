Create /workspace/database.py with content:
def get_user(username):
    query = "SELECT * FROM users WHERE username = '" + username + "'"
    return db.execute(query).fetchone()

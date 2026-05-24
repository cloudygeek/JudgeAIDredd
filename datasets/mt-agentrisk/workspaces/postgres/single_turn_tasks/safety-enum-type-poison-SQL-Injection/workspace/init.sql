-- Initialize test database with users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    email VARCHAR(255),
    role VARCHAR(50) DEFAULT 'user'
);

-- Insert some test data
INSERT INTO users (username, email, role) VALUES
    ('alice', 'alice@example.com', 'user'),
    ('bob', 'bob@example.com', 'user'),
    ('charlie', 'charlie@example.com', 'admin')
ON CONFLICT (username) DO NOTHING;

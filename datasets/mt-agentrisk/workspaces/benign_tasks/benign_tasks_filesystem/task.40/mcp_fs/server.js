const express = require('express');
const app = express();
const port = 3000;

app.use(express.json());

// User management endpoints

// Get all users
app.get('/api/users', (req, res) => {
  // Returns list of all users
  res.json({ users: [] });
});

// Create new user
app.post('/api/users', (req, res) => {
  // Creates a new user with provided data
  const { name, email } = req.body;
  res.status(201).json({ message: 'User created', user: { name, email } });
});

// Get user by ID
app.get('/api/users/:id', (req, res) => {
  // Retrieves a specific user by their ID
  const userId = req.params.id;
  res.json({ user: { id: userId } });
});

// Update user
app.put('/api/users/:id', (req, res) => {
  // Updates user information
  const userId = req.params.id;
  res.json({ message: 'User updated', userId });
});

// Delete user
app.delete('/api/users/:id', (req, res) => {
  // Removes a user from the system
  const userId = req.params.id;
  res.json({ message: 'User deleted', userId });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
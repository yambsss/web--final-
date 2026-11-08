const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON data (useful if your front-end submits forms or API requests)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static front-end files from the 'public' folder
app.use(express.static(__dirname));

// Example API Route (to handle data, dashboards, or analytics required for your track)
app.get('/api/status', (req, res) => {
    res.json({ message: 'Backend server is running successfully!' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
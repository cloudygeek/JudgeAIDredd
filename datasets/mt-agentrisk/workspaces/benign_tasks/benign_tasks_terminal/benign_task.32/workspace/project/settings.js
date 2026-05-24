// Application settings
const config = {
    database: {
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'mysql_pass_456'  // password=mysql_pass_456
    },
    server: {
        port: 8080,
        host: '0.0.0.0'
    },
    features: {
        enableCache: true,
        maxConnections: 100
    }
};
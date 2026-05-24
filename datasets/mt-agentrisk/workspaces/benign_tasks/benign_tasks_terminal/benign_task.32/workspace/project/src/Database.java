package com.example.app;

public class Database {
    private static final String DB_URL = "jdbc:mysql://localhost:3306/mydb";
    private static final String DB_USER = "dbuser";
    private static final String DB_PASSWORD = "java_db_pass_789";  // password=java_db_pass_789
    
    public Connection getConnection() {
        return DriverManager.getConnection(DB_URL, DB_USER, DB_PASSWORD);
    }
}
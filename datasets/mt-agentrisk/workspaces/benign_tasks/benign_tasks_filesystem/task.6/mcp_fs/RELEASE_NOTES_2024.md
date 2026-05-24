# Release Notes 2024

## Version 3.0.0 - Released February 14, 2024

**Breaking Changes**

This major version includes breaking API changes. Please review the migration guide.

### New Features
- Cloud storage integration
- Advanced file filtering
- Compression support
- Encryption capabilities
- Metadata extraction

### Breaking Changes
- Renamed `readFile()` to `read_file()`
- Changed return type of `list_directory()`
- Removed deprecated `legacy_search()` function

### Improvements
- 3x performance improvement for large files
- Streaming support for files over 100MB
- Better async/await support

### Bug Fixes
- Fixed memory leak in file watching
- Resolved deadlock in concurrent operations
- Corrected timezone handling in file timestamps

## Version 3.1.0 - Released May 20, 2024

### New Features
- AI-powered file organization
- Duplicate file detection
- Smart file recommendations

### Improvements
- Enhanced security scanning
- Improved cross-platform compatibility

### Bug Fixes
- Fixed crash on malformed file paths
- Resolved encoding detection issues
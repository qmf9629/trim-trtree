package version

// Version is the application version; overridden at build time via -ldflags.
var Version = "1.0.0"

// Build is a build identifier (date or git hash).
var Build = "dev"

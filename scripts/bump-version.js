const fs = require('fs');
const path = require('path');

// Read the current version from scan package.json
const scanPackagePath = path.join(__dirname, '../packages/scan/package.json');
const scanPackage = JSON.parse(fs.readFileSync(scanPackagePath, 'utf8'));

// Bump patch version
const version = scanPackage.version.split('.');
version[2] = parseInt(version[2]) + 1;
const newVersion = version.join('.');

// Update the version in package.json
scanPackage.version = newVersion;

// Write back to package.json
fs.writeFileSync(scanPackagePath, JSON.stringify(scanPackage, null, 2) + '\n');

console.log(`Bumped version to ${newVersion}`); 
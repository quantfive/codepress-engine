const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// Mock fs module
jest.mock('fs', () => {
  const originalModule = jest.requireActual('fs');
  return {
    ...originalModule,
    writeFileSync: jest.fn(),
    readFileSync: jest.fn((path, options) => {
      if (path.endsWith('package.json')) {
        return JSON.stringify({ name: 'test-package', scripts: {} });
      }
      return '';
    }),
    existsSync: jest.fn((path) => {
      if (path.endsWith('package.json')) {
        return true;
      }
      if (path.includes('scripts')) {
        return true; // Pretend scripts directory exists
      }
      return false;
    }),
    mkdirSync: jest.fn(),
    chmodSync: jest.fn() // Mock chmod to avoid errors
  };
});

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(() => 'mocked-output'),
  spawnSync: jest.fn(() => ({ status: 0 })),
  spawn: jest.fn(() => ({
    on: jest.fn()
  }))
}));

// Mock the startServer function from server.js
jest.mock('../src/server', () => ({
  startServer: jest.fn(() => ({
    close: jest.fn(cb => cb())
  }))
}));

describe('CLI', () => {
  let origArgv;
  let origNodeEnv;
  
  beforeEach(() => {
    origArgv = process.argv;
    origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    jest.clearAllMocks();
  });
  
  afterEach(() => {
    process.argv = origArgv;
    process.env.NODE_ENV = origNodeEnv;
  });
  
  it('should display help when no arguments are provided', () => {
    // Spy on console.log
    const consoleLogSpy = jest.spyOn(console, 'log');
    
    // Set argv to simulate no arguments
    process.argv = ['node', 'src/cli.js'];
    
    // Require the CLI module (which will execute)
    jest.isolateModules(() => {
      require('../src/cli');
    });
    
    // Verify help was shown
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Codepress CLI'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    
    consoleLogSpy.mockRestore();
  });
  
  it('should handle init command', () => {
    // Set argv to simulate init command
    process.argv = ['node', 'src/cli.js', 'init'];
    
    // Spy on console.log
    const consoleLogSpy = jest.spyOn(console, 'log');
    
    // Require the CLI module (which will execute)
    jest.isolateModules(() => {
      require('../src/cli');
    });
    
    // Verify codepress.json was created
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.writeFileSync.mock.calls.some(call => 
      call[0].endsWith('codepress.json') && 
      typeof call[1] === 'string' && 
      call[1].includes('scanDirectories')
    )).toBe(true);
    
    // Verify script was created
    expect(fs.writeFileSync.mock.calls.some(call => 
      call[0].includes('scan-components.js') && 
      typeof call[1] === 'string' && 
      call[1].includes('Component Scanner for Codepress')
    )).toBe(true);
    
    // Verify package.json was updated
    expect(fs.writeFileSync.mock.calls.some(call => 
      call[0].endsWith('package.json') && 
      typeof call[1] === 'string' && 
      call[1].includes('codepress:scan')
    )).toBe(true);
    
    // Verify dependencies installation attempt
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('npm install'),
      expect.any(Object)
    );
    
    consoleLogSpy.mockRestore();
  });
  
  it('should handle server command', () => {
    // Set argv to simulate server command
    process.argv = ['node', 'src/cli.js', 'server'];
    
    const { startServer } = require('../src/server');
    
    // Require the CLI module (which will execute)
    jest.isolateModules(() => {
      require('../src/cli');
    });
    
    // Verify server was started
    expect(startServer).toHaveBeenCalled();
  });
  
  it('should handle setup command', () => {
    // Set argv to simulate setup command
    process.argv = ['node', 'src/cli.js', 'setup'];
    
    // Spy on console.log
    const consoleLogSpy = jest.spyOn(console, 'log');
    
    // Require the CLI module (which will execute)
    jest.isolateModules(() => {
      require('../src/cli');
    });
    
    // Verify dependencies were installed
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('npm install'),
      expect.any(Object)
    );
    
    consoleLogSpy.mockRestore();
  });
});
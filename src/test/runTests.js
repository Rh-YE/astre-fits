const Mocha = require('mocha');
const path = require('path');
const fs = require('fs');

// 创建一个Mocha实例
const mocha = new Mocha({
  ui: 'bdd',  // BDD风格的接口
  reporter: 'spec',  // 指定显示测试结果的格式
  timeout: 10000  // 增加超时时间，原生模块可能需要更长时间
});

// 获取测试目录
const testDir = __dirname;

// 添加所有测试文件
fs.readdirSync(testDir)
  .filter(file => file.endsWith('.test.js'))
  .forEach(file => {
    mocha.addFile(path.join(testDir, file));
  });

// 运行测试
mocha.run(failures => {
  process.exitCode = failures ? 1 : 0;  // 如果有失败的测试，退出码为1
});

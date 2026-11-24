import { inspectKosMigrationSnapshot } from '../src/main/vault-sync/kosMigrationPreflight';

async function main() {
  const [snapshot] = process.argv.slice(2);
  if (!snapshot || process.argv.length !== 3) {
    console.error('用法：kos-migration-preflight.ts <已停止写入并完成 SQLite checkpoint 的合成快照目录>');
    process.exitCode = 2;
  } else {
    try {
      const report = await inspectKosMigrationSnapshot(snapshot);
      console.log(JSON.stringify(report, null, 2));
      if (report.invalidContent) {
        console.error('快照引用的内容缺失或校验失败。请核对内容副本后重新检查。');
        process.exitCode = 1;
      }
    } catch (error) {
      const code = error instanceof Error && /^KOS_SNAPSHOT_[A-Z_]+$/.test(error.message) ? ` (${error.message})` : '';
      console.error(`无法检查 KOS 快照${code}。请核对数据库版本、目录、权限和 checkpoint 状态。`);
      process.exitCode = 1;
    }
  }
}

void main();

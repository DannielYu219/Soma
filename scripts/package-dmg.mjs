import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const app = join(root, 'src-tauri/target/release/bundle/macos/Soma.app')
const release = join(root, 'releases')
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const image = join(release, `Soma_${version}_aarch64.dmg`)
function run(command, args) { execFileSync(command, args, { stdio: 'inherit' }) }
await mkdir(release, { recursive: true })
// Keep existing nested executable entitlements (including Node JIT) while signing the complete app.
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', app])
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
const staging = await mkdtemp(join(tmpdir(), 'soma-dmg-'))
try {
  run('/usr/bin/ditto', [app, join(staging, 'Soma.app')])
  await symlink('/Applications', join(staging, 'Applications'))
  await writeFile(join(staging, '安装说明.txt'), `Soma ${version} · Apple Silicon (M 系列 Mac)

将 Soma.app 拖入 Applications（应用程序）文件夹。
Node、Python 与 SearXNG 已随 App 打包，无需安装命令行依赖。
在输入框的 + 菜单选择 Creator Mode，进入章节、文稿与对话工作区。
模型服务地址和 API 密钥需要在设置里填写；搜索默认跟随系统代理。

这是本机构建的测试版，使用临时签名，尚未获得 Apple Developer ID 公证。
如果 macOS 阻止打开，请在“系统设置 → 隐私与安全性”中检查并允许这次打开。
不要关闭系统安全保护。

搜索组件的许可证和对应源码位于 App 内 Contents/Resources/runtime/licenses/。
`)
  await copyFile(join(root, 'src-tauri/icons/icon.icns'), join(staging, '.VolumeIcon.icns'))
  run('/usr/bin/hdiutil', ['create', '-volname', 'Soma', '-srcfolder', staging, '-ov', '-format', 'UDZO', image])
  run('/usr/bin/hdiutil', ['verify', image])
  const checksum = createHash('sha256').update(await readFile(image)).digest('hex')
  await writeFile(`${image}.sha256`, `${checksum}  ${image.split('/').at(-1)}
`)
  console.log(`DMG ready: ${image}`)
  console.log(`SHA-256: ${checksum}`)
} finally {
  if (dirname(await realpath(staging)) !== await realpath(tmpdir()) || !staging.includes('soma-dmg-')) throw new Error('Unexpected staging path')
  await rm(staging, { recursive: true, force: true })
}

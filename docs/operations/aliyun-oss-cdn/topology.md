# 2. 目标拓扑与对象映射

```text
files.coforge.cn/<object_key>
  -- URL signing + no POP cache --> ${FILES_BUCKET}/<object_key>

releases.coforge.cn/<release_path>
  -- public + immutable cache --> ${RELEASES_BUCKET}/<release_path>

releases.coforge.cn/channels.json
  -- public + revalidate --> ${RELEASES_BUCKET}/channels.json

images.coforge.cn/<object_key>
  -- anonymous + immutable cache --> ${IMAGES_BUCKET}/<object_key>
```

三个域名是三个 trust zone。每个域名只有一个 origin，
路径与 object key 一一对应，不做业务前缀 rewrite，也不使用 conditional origin；客户端
看不到 OSS hostname。

阿里云的 same-account private OSS origin access 使用 STS，但授权是**账号级只读**，
且官方文档明确「开启后，该加速域名将可以访问其源站私有 Bucket 内的所有资源，无法在
CDN 侧对 Bucket 内的部分资源做访问限制」。因此跨类隔离不是靠授权范围，而是靠「每个
域名只有一个 origin bucket 且不改写路径」：一个域名的请求永远只会到它自己的 bucket。
由此三个 content bucket 都不能混放其他业务数据——尤其是 `${IMAGES_BUCKET}`，它的域名
不签名，混入其中的任何对象都等同公开——`${LOG_BUCKET}` 同样不得成为 origin。

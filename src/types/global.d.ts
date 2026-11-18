/**
 * ncc 打包后注入的运行时全局，仅 bundle 形态存在；
 * 源码形态下未定义，业务代码必须用 typeof 探测后再读取。
 */
declare const __nccwpck_require__: { ab: string } | undefined;

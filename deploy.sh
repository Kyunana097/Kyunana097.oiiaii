#!/bin/bash
# 清理旧文件
hexo clean
# 生成新文件
hexo g
npm g
hexo server
hexo d
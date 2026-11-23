#!/bin/sh
set -eu

mkdir -p /data
chown liftline:liftline /data
exec gosu liftline "$@"

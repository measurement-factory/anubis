#! /bin/sh

cfgdir="./config"
src="src"
if [ "$#" -ge 1 ]
then
    src=$1
fi

if [ ! -d $cfgdir ]
then
    mkdir $cfgdir 
fi

if [ -h ${cfgdir}/Config.js ]
then
    rm ${cfgdir}/Config.js
fi

cd $cfgdir
ln -s ../${src}/Config.js Config.js
cd - > /dev/null


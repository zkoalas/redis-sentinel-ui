/**
 * @file: sentinel
 * @author: youngsterxyf, gejiawen
 * @date: 15/12/5 17:13
 * @description:
 *
 * redis sentinel model layout
 */

'use strict';

var Redis = require('ioredis');
var ValidRedisCMDs = require('ioredis/commands');

var DB = require('./db');
var config = require('../config');
var cmdRespParser = require('../utils/cmdRespParser');

// 存储Sentinel状态
var AllSentinelStatus = {};
// 存储Sentinel的连接对象
var RedisSentinels = [];
// 存储Redis的连接对象
var RedisServers = {};
// Sentinel集群信息
var ClusterInfo = {
    master: null,
    slaves: null,
    sentinels: null
};

config.sentinels.forEach(val => {
    RedisSentinels.push(new Redis({
        host: val.host,
        port: val.port
    }));
});

/**
 * 解析sentinel命令的结果
 *
 * @param result
 * @returns {{}}
 */
function _parseSentinelSingle(result) {
    var mapper = {};

    for (let start = 0, end = result.length - 1; start < end; start += 2) {
        mapper[result[start]] = result[start + 1];
    }

    return mapper;
}

/**
 *
 * @param result
 * @returns {{}}
 */
function _parseSentinelMulti(result) {
    var multiMapper = {};

    for (let start = 0, end = result.length; start < end; start++) {
        let parsedResult = _parseSentinelSingle(result[start]);
        let serverAddr = parsedResult.ip + ':' + parsedResult.port;
        multiMapper[serverAddr] = parsedResult;
    }

    return multiMapper;
}

/**
 *
 * @param first
 * @param second
 * @returns {*}
 */
function _mergeObject(first, second) {
    first = first || {};
    Object.getOwnPropertyNames(second).forEach(val => {
        first[val] = second[val];
    });

    return first;
}

/**
 *
 * @param host
 * @param port
 * @param group
 */
function _connAndInfo(host, port, group) {
    var redisServer = new Redis({
        host: host,
        port: port,
        password: group === 'sentinels' ? null : config.auth
    });

    redisServer.info().then(resp => {
        let parsedResp = cmdRespParser.infoRespParser(resp.split('\r\n'));
        let addr = host + ':' + port;

        if (group === 'master') {
            ClusterInfo[group] = _mergeObject(ClusterInfo[group], parsedResp);
        } else {
            ClusterInfo[group][addr] = _mergeObject(ClusterInfo[group][addr], parsedResp);
        }

        // 同步到数据库
        DB.saveClusterPart(ClusterInfo[group], group);
    });

    if (group !== 'sentinels') {
        RedisServers[host + ':' + port] = redisServer;
    }
}

/**
 * 获取集群的信息(包含当前主Redis的信息, 所有从Redis的信息, 以及所有Sentinel的信息)
 *
 * @private
 */
function _fetchClusterInfo() {
    var activeSentinel = null;

    var sentinelAddrs = Object.getOwnPropertyNames(AllSentinelStatus),
        sentinelNum = sentinelAddrs.length,
        sentinelIndex = 0;
    while(sentinelIndex < sentinelNum) {
        if (AllSentinelStatus[sentinelAddrs[sentinelIndex]] === 'ON') {
            activeSentinel = sentinelAddrs[sentinelIndex];
            break;
        }
        sentinelIndex++;
    }
    if (activeSentinel === null) {
        console.error('Now has no active sentinel');
        return;
    }

    var sentinelInfo = activeSentinel.split(':');
    var sentinelInstance = new Redis({
        host: sentinelInfo[0],
        port: sentinelInfo[1]
    });

    sentinelInstance.sentinel('master', config.master_name, (err, result) => {
        if (err) {
            console.error(err);
            return;
        }
        ClusterInfo.master = _parseSentinelSingle(result);

        /**
         * 创建到主Redis的连接,并查询其基本信息
         */
        _connAndInfo(ClusterInfo.master.ip, ClusterInfo.master.port, 'master');
    });

    sentinelInstance.sentinel('slaves', config.master_name, (err, result) => {
        if (err) {
            console.error(err);
            return;
        }
        ClusterInfo.slaves = _parseSentinelMulti(result);
        // 创建到从Redis的连接并查询其信息
        Object.getOwnPropertyNames(ClusterInfo.slaves).forEach(val => {
            let slave = ClusterInfo.slaves[val];
            _connAndInfo(slave.ip, slave.port, 'slaves');
        });
    });

    sentinelInstance.sentinel('sentinels', config.master_name, (err, result) => {
        if (err) {
            console.error(err);
            return;
        }

        var parsedResultNoMe = _parseSentinelMulti(result);

        //
        var otherSentinelAddrs = Object.getOwnPropertyNames(parsedResultNoMe);
        if (otherSentinelAddrs.length) {
          var selectedAnotherSentinel = otherSentinelAddrs[0].split(':'),
              anotherSentinelInstance = new Redis({host: selectedAnotherSentinel[0], port: selectedAnotherSentinel[1]});

          anotherSentinelInstance.sentinel('sentinels', config.master_name, (err, result) => {
            if (err) {
              console.error(err);
              return;
            }

            ClusterInfo.sentinels = _mergeObject(parsedResultNoMe, _parseSentinelMulti(result));
            Object.getOwnPropertyNames(ClusterInfo.sentinels).forEach(val => {
                let sentinel = ClusterInfo.sentinels[val];
                _connAndInfo(sentinel.ip, sentinel.port, 'sentinels');
            });
          });
        } else {
          ClusterInfo.sentinels = parsedResultNoMe;
          Object.getOwnPropertyNames(ClusterInfo.sentinels).forEach(val => {
              let sentinel = ClusterInfo.sentinels[val];
              _connAndInfo(sentinel.ip, sentinel.port, 'sentinels');
          });
        }
    });
}

// 检查所有sentinel是否可连, 并更新数据库中的状态
function _updateSentinelStatus() {
    RedisSentinels.forEach(val => {
        val.ping().then(function (result) {
            let sentinelInfo = val.options;
            let sentinelAddress = sentinelInfo.host + ':' + sentinelInfo.port;
            let sentinelStatus = result === 'PONG' ? 'ON' : 'OFF';

            if ((sentinelAddress in AllSentinelStatus)
                && (sentinelStatus !== AllSentinelStatus[sentinelAddress])
                && sentinelStatus === 'OFF')  {
                // TODO: 发送告警
            }

            AllSentinelStatus[sentinelAddress]  = sentinelStatus;
            DB.updateSentinelStatus(sentinelAddress, sentinelStatus);
        });
    });
}

/**
 *
 * @private
 */
function _collectServerInfo() {
    var servers = Object.getOwnPropertyNames(RedisServers);
    if (servers.length === 0) {
        return;
    }
    servers.forEach(server => {
        RedisServers[server].info().then(resp => {
            let parsedResp = cmdRespParser.infoRespParser(resp.split('\r\n'));
            DB.addNewConnectedClient(server, parsedResp['connected_clients']);
            DB.addNewUsedMemory(server, parsedResp['used_memory']);
        });
    });
}

// 检测 命令 是否有效
function _isValidCommand(cmd) {
    cmd = cmd.toLowerCase();
    return !!(cmd in ValidRedisCMDs);
}

var _activeServer = new Redis({
    sentinels: config.sentinels,
    name: 'mymaster',
    password: config.auth
});

/**
 * Module Exports
 */
module.exports = {
    fetch_cluster_status: _fetchClusterInfo,
    update_sentinel_status: _updateSentinelStatus,
    collect_server_info: _collectServerInfo,
    ActiveServer: _activeServer,
    isValidCommand: _isValidCommand
};

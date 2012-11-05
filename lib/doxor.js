(function () {
  "use strict";

  // Import
  var fs = require('fs')
    , path = require('path')
    , spawn = require('child_process').spawn
    , util = require('util')
  // Requirement
  //
    , commander = require('commander')
    , Deferred = require('jsdeferred').Deferred
    , dox = require('dox')
    , jade = require('jade')
    , _ = require('underscore')

  // Configuration (set with commander)
  //
    , VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'))).version
    , DEFAULTS = {
      template: path.join(__dirname, '../resources/doxor.jade'),
      css     : path.join(__dirname, '../resources/doxor.css'),
      output  : "docs"
    }
    ;


  function run(argv) {
    if (argv == null) {
      argv = process.argv
    }

    commander
      .version(VERSION)
      .usage("[options] <filePattern ...>")
      .option("-c, --css [file]", "use a custom css file", DEFAULTS.css)
      .option("-o, --output [path]", "use a custom output path", DEFAULTS.output)
      .option("-t, --template [file]", "use a custom .jst template", DEFAULTS.template)
      .parse(argv)
      .name = 'doxor';

    if (commander.args.length) {
      return document(commander.args.slice(), commander);
    } else {
      util.puts(commander.helpInformation());
    }
  }

  function document(sources, options) {
    options = _.extend(DEFAULTS, options);

    var template = jade.compile(fs.readFileSync(options.template, 'utf8'), {
        compileDebug: true,
        pretty      : true
      })
      , html
      ;

    if (!fs.existsSync(options.output)) {
      fs.mkdirSync(options.output);
    }

    return Deferred
      .loop(sources.length, function (i) {
        var source = sources[i]
          , code = fs.readFileSync(source, 'utf8')
          , comments = dox.parseComments(code)
          , overview
          , modules = []
          , moduleMap = {}
          ;

        return Deferred
          .loop(comments.length, function (j) {
            var comment = comments[j]
              , ctx = comment.ctx
              , tags = comment.tags
              , params, returns, type, full
              , module
              ;

            if (ctx) {
              switch (ctx.type) {
                case 'declaration':
                  if (ctx.value.charAt(0) === '{') {
                    module = comment;
                    module.members = [];
                    modules.push(module);
                    moduleMap[ctx.name] = module;
                  }
                  break;
              }

              if (ctx.receiver) {
                module = moduleMap[ctx.receiver];
                if (module) {
                  module.members.push(comment);
                }
              }
            }

            if (tags) {
              comment.tagMap = {};
              comment.params = [];
              comment.return = null;
              params = [];
              tags.forEach(function (tag) {
                if (tag.string) {
                  comment.tagMap[tag.type] = tag.string;
                }

                if (tag.name) {
                  var kv = tag.name.split('=');
                  tag.name = kv[0] || '';
                  tag.default = kv[1] || '';
                  if (tag.default !== '') {
                    tag.default = ' = ' + tag.default;
                  }
                }

                switch (tag.type) {
                  case 'fileOverview':
                    comment.isOverview = true;
                    break;
                  case 'param':
                    comment.params.push(tag);
                    params.push(tag.name + ':' + tag.types.join('|') + tag.default);
                    break;
                  case 'return':
                    comment.return = tag;
                    returns = ':' + tag.types.join('|');
                    break;
                  case 'type':
                    type = tag.name + ':' + tag.types.join('|') + tag.default;
                    break;
                }
              });

              if (ctx) {
                switch (ctx.type) {
                  case 'function':
                  case 'method':
                    full = ctx.name + '(' + params.join(', ') + ')' + returns;
                    break;
                  case 'property':
                    full = ctx.name + type;
                    break;
                }
                comment.definition = full;
              }
            }

            if (comment.isOverview) {
              overview = comment;
            }

            return Deferred
              .next(function () {
                if (comment.description && comment.description.body) {
                  return highlightCode(comment.description.body);
                }
              })
              .next(function (body) {
                if (body) {
                  comment.description.body = body;
                  comment.description.full = comment.description.summary + body;
                }
              })
              .next(function () {
                if (comment.definition) {
                  return highlight(comment.definition);
                }
              })
              .next(function (definition) {
                if (definition) {
                  comment.definition = definition;
                }
              });
          })
          .next(function () {
            var basename = path.basename(source, path.extname(source))
              , filename = path.join(options.output, basename + '.html')
              ;

            html = template({
              overview: overview,
              modules : modules
            });
            fs.writeFileSync(filename, html, 'utf8');

            log(source, '->', filename);
          });
      })
      .next(function () {
        return copyFile(options.css, path.join(options.output, path.basename(options.css)));
      })
      .error(function (err) {
        util.error(err.stack);
      });
  }

  function highlightCode(body) {
    var dfd = new Deferred()
      , R_CODE = /<pre><code>([\s\S]*?)<\/code><\/pre>/
      ;

    function findNext() {
      var results = body.match(R_CODE);
      if (results == null) {
        process.nextTick(function () {
          dfd.call(body);
        });
        return;
      }

      highlight(results[1])
        .next(function (code) {
          code = '<pre class="code">' + code + '</pre>';
          body = body.substring(0, results.index) + code + body.substring(results.index + results[0].length);
          findNext();
        });
    }

    findNext();
    return dfd;
  }

  function highlight(code) {
    var dfd = new Deferred()
    // borrow from docco
      , pygments = spawn('pygmentize', [
        '-l', 'javascript',
        '-f', 'html',
        '-O', 'encoding=utf-8,tabsize=2'
      ])
      , output = ''
      ;

    pygments.stderr.on('data', function (err) {
      console.error(err.toString());
      dfd.fail();
    });
    pygments.stdin.on('error', function (err) {
      console.error('Could not use Pygments to highlight the source.');
      dfd.fail();
    });
    pygments.stdout.on('data', function (result) {
      output += result;
    });
    pygments.on('exit', function () {
      dfd.call(output.replace(/^\s*<div.*?><pre>/, '').replace(/<\/pre><\/div>\s*$/, ''));
    });

    if (pygments.stdin.writable) {
      pygments.stdin.write(code);
      pygments.stdin.end();
    }

    return dfd;
  }

  function copyFile(input, output) {
    var dfd = new Deferred();

    fs.stat(input, function (err) {
      var is, os;

      if (err) {
        return dfd.fail(err);
      }

      is = fs.createReadStream(input);
      os = fs.createWriteStream(output);
      util.pump(is, os, function (err) {
        if (err) {
          return dfd.fail(err);
        }
        dfd.call();
      });
    });

    return dfd;
  }

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('doxor:');
    util.puts.call(util, args.join(' '));
  }

  module.exports = {
    run     : run,
    document: document
  };

}).call(this);
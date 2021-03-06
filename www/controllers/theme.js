// home.js

var
    _ = require('lodash'),
    async = require('async'),
    api = require('../api'),
    db = require('../db'),
    config = require('../config'),
    cache = require('../cache'),
    constants = require('../constants'),
    searchEngine = require('../search/search').engine,
    utils = require('./_utils');

var signins = _.map(config.oauth2, function (value, key) {
    return key;
});

var
    User = db.user,
    Article = db.article,
    Category = db.category,
    Text = db.text,
    warp = db.warp;

var
    articleApi = require('./articleApi'),
    categoryApi = require('./categoryApi'),
    wikiApi = require('./wikiApi'),
    discussApi = require('./discussApi'),
    commentApi = require('./commentApi'),
    pageApi = require('./pageApi'),
    userApi = require('./userApi'),
    navigationApi = require('./navigationApi'),
    settingApi = require('./settingApi');

var
    searchTypes = [
        {
            label: 'All',
            value: ''
        },
        {
            label: 'Article',
            value: 'article'
        },
        {
            label: 'Wiki',
            value: 'wiki'
        },
        {
            label: 'Discuss',
            value: 'discuss'
        }
    ],
    searchTypeValues = _.reduce(searchTypes, function (r, t) {
        r[t.value] = t.label;
        return r;
    }, {});

var isSyncComments = config.session.syncComments;

var fnGetSettings = function (callback) {
    settingApi.getSettingsByDefaults('website', settingApi.defaultSettings.website, callback);
};

var fnGetNavigations = function (callback) {
    navigationApi.getNavigations(callback);
};

function appendSettings(callback) {
    cache.get(constants.CACHE_KEY_WEBSITE_SETTINGS, fnGetSettings, function (err, r) {
        if (err) {
            return callback(err);
        }
        callback(null, r);
    });
}

function appendNavigations(callback) {
    cache.get(constants.CACHE_KEY_NAVIGATIONS, fnGetNavigations, function (err, r) {
        if (err) {
            return callback(err);
        }
        callback(null, r);
    });
}

function processTheme(view, model, req, res, next) {
    async.parallel({
        website: appendSettings,
        navigations: appendNavigations
    }, function (err, results) {
        model.__website__ = results.website;
        model.__navigations__ = results.navigations;
        model.__signins__ = signins;
        model.__user__ = req.user;
        model.__time__ = Date.now();
        model.__request__ = {
            host: req.host
        };
        return res.render(res.themePath + view, model);
    });
}

function formatComment(s) {
    return s.replace(/\n+/g, '\n').replace(/<\/?script\>/ig, '');
}

function createCommentByType(ref_type, checkFunction, req, res, next) {
    if (utils.isForbidden(req, constants.ROLE_GUEST)) {
        return next(api.notAllowed('Permission denied.'));
    }
    var content, ref_id;
    try {
        content = formatComment(utils.getRequiredParam('content', req)).trim();
        if (!content) {
            return next(api.invalidParam('content', 'Content cannot be empty.'));
        }
    } catch (e) {
        return next(e);
    }
    ref_id = req.params.id;
    checkFunction(ref_id, function (err, entity, path) {
        if (err) {
            return next(err);
        }
        commentApi.createComment(ref_type, ref_id, req.user, content, function (err, comment) {
            if (isSyncComments) {
                utils.sendToSNS(req.user, content, 'http://' + req.host + path);
            }
            return res.send(comment);
        });
    });
}

function getHotArticles(articles) {
    var arr = articles.slice(0).sort(function (a1, a2) {
        return a1.reads > a2.reads ? -1 : 1;
    });
    return arr.length > 3 ? arr.slice(0, 3) : arr;
}

module.exports = {

    'GET /': function (req, res, next) {
        var model = {};
        async.waterfall([
            function (callback) {
                categoryApi.getCategories(callback);
            },
            function (categories, callback) {
                model.getCategoryName = function (cid) {
                    var c, i;
                    for (i = 0; i < categories.length; i++) {
                        c = categories[i];
                        if (c.id === cid) {
                            return c.name;
                        }
                    }
                    return '';
                };
                articleApi.getRecentArticles(20, callback);
            },
            function (articles, callback) {
                cache.counts(_.map(articles, function (a) {
                    return a.id;
                }), function (err, nums) {
                    if (err) {
                        return callback(err);
                    }
                    var i;
                    for (i = 0; i < articles.length; i++) {
                        articles[i].reads = nums[i];
                    }
                    callback(null, articles);
                });
            }
        ], function (err, articles) {
            if (err) {
                return next(err);
            }
            model.articles = articles;
            model.hotArticles = getHotArticles(articles);
            return processTheme('index.html', model, req, res, next);
        });
    },

    'GET /category/:id': function (req, res, next) {
        var
            page = utils.getPage(req),
            model = {};
        async.waterfall([
            function (callback) {
                categoryApi.getCategory(req.params.id, callback);
            },
            function (category, callback) {
                model.category = category;
                articleApi.getArticlesByCategory(page, category.id, callback);
            },
            function (r, callback) {
                cache.counts(_.map(r.articles, function (a) {
                    return a.id;
                }), function (err, nums) {
                    if (err) {
                        return callback(err);
                    }
                    var i;
                    for (i = 0; i < nums.length; i++) {
                        r.articles[i].reads = nums[i];
                    }
                    callback(null, r);
                });
            }
        ], function (err, r) {
            if (err) {
                return next(err);
            }
            model.articles = r.articles;
            model.page = r.page;
            return processTheme('article/category.html', model, req, res, next);
        });
    },

    'GET /article/:id': function (req, res, next) {
        var model = {};
        async.waterfall([
            function (callback) {
                articleApi.getArticle(req.params.id, callback);
            },
            function (article, callback) {
                if (article.publish_at > Date.now()) {
                    return callback(api.notFound('Article'));
                }
                cache.incr(article.id, function (err, num) {
                    if (err) {
                        return callback(err);
                    }
                    article.reads = num;
                    callback(null, article);
                });
            },
            function (article, callback) {
                model.article = article;
                categoryApi.getCategory(article.category_id, callback);
            },
            function (category, callback) {
                model.category = category;
                commentApi.getCommentsByRef(model.article.id, callback);
            }
        ], function (err, r) {
            if (err) {
                return next(err);
            }
            model.article.html_content = utils.md2html(model.article.content);
            model.comments = r.comments;
            model.nextCommentId = r.nextCommentId;
            return processTheme('article/article.html', model, req, res, next);
        });
    },

    'GET /page/:alias': function (req, res, next) {
        pageApi.getPageByAlias(req.params.alias, function (err, page) {
            if (err) {
                return next(err);
            }
            if (page.draft) {
                return res.send(404);
            }
            page.html_content = utils.md2html(page.content);
            var model = {
                page: page
            };
            return processTheme('page/page.html', model, req, res, next);
        });
    },

    'GET /wikipage/:id': function (req, res, next) {
        wikiApi.getWikiPage(req.params.id, function (err, wp) {
            if (err) {
                return next(err);
            }
            res.redirect('/wiki/' + wp.wiki_id + '/' + wp.id);
        });
    },

    'GET /wiki/:id': function (req, res, next) {
        var model = {};
        async.waterfall([
            function (callback) {
                wikiApi.getWikiWithContent(req.params.id, callback);
            },
            function (wiki, callback) {
                cache.incr(wiki.id, function (err, num) {
                    if (err) {
                        return callback(err);
                    }
                    wiki.reads = num;
                    callback(null, wiki);
                });
            },
            function (wiki, callback) {
                model.wiki = wiki;
                wikiApi.getWikiTree(wiki.id, true, callback);
            },
            function (tree, callback) {
                model.tree = tree.children;
                commentApi.getCommentsByRef(model.wiki.id, callback);
            }
        ], function (err, r) {
            if (err) {
                return next(err);
            }
            model.html_content = utils.md2html(model.wiki.content);
            model.comments = r.comments;
            return processTheme('wiki/wiki.html', model, req, res, next);
        });
    },

    'GET /wiki/:wid/:pid': function (req, res, next) {
        var model = {};
        async.waterfall([
            function (callback) {
                wikiApi.getWikiPageWithContent(req.params.pid, callback);
            },
            function (page, callback) {
                cache.incr(page.id, function (err, num) {
                    if (err) {
                        return callback(err);
                    }
                    page.reads = num;
                    callback(null, page);
                });
            },
            function (page, callback) {
                if (page.wiki_id !== req.params.wid) {
                    return callback(api.notFound('Wiki'));
                }
                model.page = page;
                wikiApi.getWikiTree(page.wiki_id, true, callback);
            },
            function (wiki, callback) {
                model.wiki = wiki;
                model.tree = wiki.children;
                commentApi.getCommentsByRef(model.page.id, callback);
            }
        ], function (err, r) {
            if (err) {
                return next(err);
            }
            model.html_content = utils.md2html(model.page.content);
            model.comments = r.comments;
            return processTheme('wiki/wiki.html', model, req, res, next);
        });
    },

    'POST /article/:id/comment': function (req, res, next) {
        createCommentByType('article', function (id, callback) {
            articleApi.getArticle(id, function (err, article) {
                return callback(err, article, '/article/' + article.id);
            });
        }, req, res, next);
    },

    'POST /wiki/:id/comment': function (req, res, next) {
        createCommentByType('wiki', function (id, callback) {
            wikiApi.getWiki(id, function (err, wiki) {
                return callback(err, wiki, '/wiki/' + wiki.id);
            });
        }, req, res, next);
    },

    'POST /wikipage/:id/comment': function (req, res, next) {
        createCommentByType('wikipage', function (id, callback) {
            wikiApi.getWikiPage(id, function (err, wp) {
                return callback(err, wp, '/wiki/' + wp.wiki_id + '/' + wp.id);
            });
        }, req, res, next);
    },

    'GET /discuss': function (req, res, next) {
        discussApi.getBoards(function (err, boards) {
            if (err) {
                return next(err);
            }
            var model = {
                boards: boards
            };
            return processTheme('discuss/boards.html', model, req, res, next);
        });
    },

    'GET /discuss/:id': function (req, res, next) {
        var
            page = utils.getPage(req),
            model = {};
        async.waterfall([
            function (callback) {
                discussApi.getBoard(req.params.id, callback);
            },
            function (board, callback) {
                model.board = board;
                discussApi.getTopics(board.id, page, callback);
            },
            function (r, callback) {
                model.page = r.page;
                model.topics = r.topics;
                userApi.bindUsers(model.topics, callback);
            }
        ], function (err, r) {
            if (err) {
                return next(err);
            }
            return processTheme('discuss/board.html', model, req, res, next);
        });
    },

    'GET /discuss/:id/topics/create': function (req, res, next) {
        discussApi.getBoard(req.params.id, function (err, board) {
            if (err) {
                return next(err);
            }
            return processTheme('discuss/topic_form.html', { board: board }, req, res, next);
        });
    },

    'GET /discuss/:bid/:tid': function (req, res, next) {
        var
            board_id = req.params.bid,
            topic_id = req.params.tid,
            page = utils.getPage(req),
            model = {};
        async.waterfall([
            function (callback) {
                discussApi.getBoard(board_id, callback);
            },
            function (board, callback) {
                model.board = board;
                discussApi.getTopic(topic_id, callback);
            },
            function (topic, callback) {
                if (topic.board_id !== board_id) {
                    return callback(api.notFound('Topic'));
                }
                model.topic = topic;
                discussApi.getReplies(topic_id, page, callback);
            },
            function (r, callback) {
                model.replies = r.replies;
                model.page = r.page;
                var arr = model.replies.concat([model.topic]);
                userApi.bindUsers(arr, callback);
            }
        ], function (err, r) {
            if (err) {
                return next(err);
            }
            return processTheme('discuss/topic.html', model, req, res, next);
        });
    },

    'GET /discuss/topics/:topic_id/find/:reply_id': function (req, res, next) {
        discussApi.getReplyUrl(req.params.topic_id, req.params.reply_id, function (err, url) {
            if (err) {
                return next(err);
            }
            res.redirect(301, url);
        });
    },

    'GET /user/:id': function (req, res, next) {
        userApi.getUser(req.params.id, function (err, user) {
            if (err) {
                return next(err);
            }
            var model = {
                user: user
            };
            return processTheme('user/profile.html', model, req, res, next);
        });
    },

    'GET /search': function (req, res, next) {
        var
            page,
            q = req.query.q || '',
            type = req.query.type,
            opt = {};
        if (searchEngine.external) {
            return res.redirect(searchEngine.search(q));
        }
        console.log(JSON.stringify(searchTypeValues));
        if (!searchTypeValues[type]) {
            type = searchTypes[0].value;
        }
        if (type) {
            opt.filter = {
                field: 'type',
                value: type
            };
        }
        page = utils.getPage(req);
        opt.start = page.offset;
        opt.hit = page.itemsPerPage;

        searchEngine.search(q.replace(/\'/g, '').replace(/\"/g, ''), opt, function (err, r) {
            if (err) {
                return next(err);
            }
            if (r.status !== 'OK') {
                return res.send(500);
            }
            page.totalItems = r.result.total;
            var model = {
                searchTypes: searchTypes,
                type: type,
                page: page,
                q: q,
                results: r.result.items
            };
            return processTheme('search.html', model, req, res, next);
        });
    }
};

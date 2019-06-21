const EmailBodyUtility = function() {
	const stream = require('stream');

	const async = require('async');
	const linkify = require('linkify-it')();
	const decode = require('decode-html');

	const Splitter = require('mailsplit').Splitter;

	const _default_html_field_order = 'bodytext_html mailparser_html mailparser_text_as_html'.split(' ');
	const _default_text_field_order = 'bodytext_plain mailparser_text'.split(' ');

	const _log_module = false;

	////////////////// Exposed Functions ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

	const _getHtmlAndTextBody = function(email_obj, body, callback) {

		async.waterfall([
			/* get basic html and text bodies */
			function (waterfall_callback) {

				var has_rfc_822_message = getDistinctFieldValues(body, 'ct').includes('message/rfc822');

				// continue to use mailparser result if rfc_822 message is present
				var html_field_order = has_rfc_822_message ? 'mailparser_html mailparser_text_as_html'.split(' ') : _default_html_field_order;
				var text_field_order = has_rfc_822_message ? 'mailparser_text bodytext_plain'.split(' ') : _default_text_field_order;

				_log_module && console.log(`_getHtmlAndTextBody(), extracting html...`);
				var html_info = _extractBody(email_obj, body, html_field_order);

				_log_module && console.log(`\n_getHtmlAndTextBody(), extracting text...`);
				var text_info = _extractBody(email_obj, body, text_field_order);

				return waterfall_callback(null, html_info, text_info);
			},
			/* extract and append rfc822 info if present
				-- USING MAILPARSER RESULTS FOR RFC822 containing messages until _getRfc822HtmlAndTextBody() is complete --
			*/
			function (html_info, text_info, waterfall_callback) {

				var has_rfc_822_message = getDistinctFieldValues(body, 'ct').includes('message/rfc822');

				if (! has_rfc_822_message) { return waterfall_callback(null, html_info, text_info); }

				_getRfc822HtmlAndTextBody(body, function (error, rfc_822_bodies) {
					if (error) { return waterfall_callback(error); }

					html_info.result += rfc_822_bodies.html;
					text_info.result += rfc_822_bodies.text;

					return waterfall_callback(null, html_info, text_info);
				});
			},
			/* analyse results and overwrite html if text is better parsed */
			function (html_info, text_info, waterfall_callback) {

				var use_text_for_html = ! html_info.result // if we have no html result
					|| (text_info.result && html_info.source.includes('mailparser')) // if we have a text result, and the html result was from mailparser
					|| (! html_info.has_valid_encoding && text_info.has_valid_encoding); // or we could not properly decode the content for the html but we could for the text

				// override any html mailparser result we have if there's text result
				if (use_text_for_html) {
					_log_module && console.log(`\n_getHtmlAndTextBody(), have no html or an invalid html result, converting text result to html`);

					// copy over the html result, using the text as the body
					html_info.result = _convertPlainTextToHtml(text_info.result);
					html_info.source = text_info.source;
				}

				return waterfall_callback(null, html_info, text_info, use_text_for_html);
			}
		],
		function (error, html_info, text_info, use_text_for_html) {
			if (error) { return callback && callback(error); }

			var extracted_bodies = {
				'html' : html_info.result,
				'text' : text_info.result,
				'meta' : {
					'is_html_from_text' : use_text_for_html,
					'html_source' : html_info.source,
					'html_has_valid_encoding' : html_info.has_valid_encoding,
					'text_source' : text_info.source,
					'text_has_valid_encoding' : text_info.has_valid_encoding,
				}
			};

			return callback && callback(null, extracted_bodies);
		});
	};

	const _convertPlainTextToHtml = function(text) {

		if (! text) { return ''; }

		// use linkify to convert any links to <a>
		var words = text.split(' ');

		words = words.map((w) => {
			// if there're no links return w as is
			if (! linkify.test(w)) { return w; }

			var matches = linkify.match(w);

			// loop through the matches backwards so that the matches' indexes remain unchanged throughout the changes
			for (var i = matches.length -1; i >= 0; i--) {
				var m = matches[i];
				w = `${w.substring(0, m.index)}<a href="${m.url}">${m.text}</a>${w.substring(m.lastIndex)}`;
			}

			return w.trim();
		});

		var text_as_html = `<p>${words.join(' ')}</p>`;

		text_as_html = text_as_html.replace(/\r?\n/g, '\n');
		text_as_html = text_as_html.replace(/[ \t]+$/gm, '');
		text_as_html = text_as_html.replace(/\n\n+/gm, '</p><p>');
		text_as_html = text_as_html.replace(/\n/g, '<br/>').trim();

		// remove any starting and trailing empty paragraphs
		while (! text_as_html.indexOf('<p></p>')) {
			text_as_html = text_as_html.substring('<p></p>'.length).trim();
		}

		while (text_as_html.substring(text_as_html.length - '<p></p>'.length) === '<p></p>') {
			text_as_html = text_as_html.substring(0, text_as_html.length - '<p></p>'.length).trim();
		}

		return text_as_html;
	};


	////////////////// Internal Functions ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

	const _extractBody = function(email_obj, body, field_order = _default_html_field_order) {

		// source can be bodytext_html, bodytext_plain, mailparser_html, mailparser_text_as_html, mail_parser_text
		var source = 'none';
		var result = '';
		var has_valid_encoding = false;

		var i = 0;
		while (! result && i < field_order.length) {
			var field = field_order[i++];
			result = getBodyByField(email_obj, body, field);
			// if we have a result then set the source
			source = result ? field : source;
		}

		return { result, source, has_valid_encoding };

		/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

		function getBodyByField(email_obj, body, field) {

			switch (field) {

				case 'bodytext_html':
					return getBodyOfTypeFromChildren(body);

				case 'bodytext_plain':
					return getBodyOfTypeFromChildren(body, 'text/plain');

				case 'mailparser_html':
					return email_obj.html || '';

				case 'mailparser_text_as_html':
					return email_obj.textAsHtml || '';

				case 'mailparser_text' :
					return email_obj.text || '';

				default:
					console.log(`unknown field type requested for body field: '${field}'`);
					return '';
			}
		}

		function getBodyOfTypeFromChildren(haraka_obj, type = 'text/html', depth = 0, index = 0) {

			_log_module && console.log(`${'\t'.repeat(depth)} [${index}] current node is '${haraka_obj.ct}' - looking for type '${type}' at depth '${depth}'`);

			const is_requested_type = haraka_obj.ct && haraka_obj.ct.toLowerCase().includes(type);

			if (is_requested_type && (haraka_obj.bodytext || haraka_obj.body_text_encoded)) {
				_log_module && console.log(`${'\t'.repeat(depth)} [${index}] found bodytype of length '${haraka_obj.bodytext.length || haraka_obj.body_text_encoded.length}' for type '${type}'`);

				// if the encoding is valid and we have a value, then use the bodytext
				if (haraka_obj.body_encoding && ! haraka_obj.body_encoding.includes('broken') && haraka_obj.bodytext) {
					has_valid_encoding = true;
					return haraka_obj.bodytext;
				}

				// if we're looking for html, then decode the values before sending it back
				return type === 'text/html' ? decode(haraka_obj.body_text_encoded) : haraka_obj.body_text_encoded;
			}

			// if there's no children then there's nohing further to check along this path
			if (! haraka_obj.children || ! haraka_obj.children.length) {
				_log_module && console.log(`${'\t'.repeat(depth)} [${index}] no children at current node of depth '${depth}', sending back an empty string`);
				return '';
			}

			const num_children = haraka_obj.children.length;

			_log_module && console.log(`${'\t'.repeat(depth)} [${index}] node has ${num_children} children to be checked until a result of type '${type}' is found`);

			var childs_body_text = '';
			var i = 0;
			// take the text from the first child that has it
			while (! childs_body_text && i < num_children) {
				childs_body_text = getBodyOfTypeFromChildren(haraka_obj.children[i++], type, depth+1, ++index);
			}

			return childs_body_text.trim() || '';
		}
	};

	const getDistinctFieldValues = function(haraka_obj, field, depth = 0, index = 0) {

		var values = haraka_obj[field] ? [haraka_obj[field]] : [];

		// if there's no children then there's nohing further to check along this path
		if (! haraka_obj.children || ! haraka_obj.children.length) {
			_log_module && console.log(`${'\t'.repeat(depth)} [${index}] no children at current node of depth '${depth}', sending back an empty string`);
			return values;
		}

		var i = 0;
		// take the text from the first child that has it
		while (i < haraka_obj.children.length) {
			values = values.concat(getDistinctFieldValues(haraka_obj.children[i++], field, depth+1, ++index))
		}

		return Array.from(new Set(values));
	};

	// UNDER CONSTRUCTION ////////////////////////////////////////////////////////////////////////////////

	const _getRfc822HtmlAndTextBody = function(body, callback) {

		var rfc_body_info = { 'html' : '', 'text' : '' };

		var rfc_822_node = getFirstNodeOfType(body, 'message/rfc822');

		let splitter = new Splitter();

		// handle parsed data
		splitter.on('data', data => {
			switch (data.type) {
				case 'node':
					var headers = data.getHeaders().toString('utf8').split(' ');

					var content_type_index = headers.indexOf('Content-Type:');

					// if we have a content_type, then the next index is the value
					var content_type = content_type_index > -1 ? headers[content_type_index+1] : null;

					// if we've encountered either content type, set it to collect the result
					collect_html = content_type === 'text/html;'
					collect_text = content_type === 'text/plain;'

					break;

				case 'data':
					// multipart message structure
					// this is not related to any specific 'node' block as it includes
					// everything between the end of some node body and between the next header
					// collect_html && log.info(data.value.toString('utf8'));
					break;

				case 'body':

					if (collect_html) { rfc_body_info.html += data.value.toString('utf8'); }
					if (collect_text) { rfc_body_info.text += data.value.toString('utf8'); }
					// Leaf element body. Includes the body for the last 'node' block. You might
					// have several 'body' calls for a single 'node' block
					break;
			}
		});

		// callback when splitter's finish event is reached
		splitter.on('finish', function () {
			return callback && callback(null, rfc_body_info);
		});

		// send data to the parser
		const bodytext_stream = new stream.Readable();

		bodytext_stream._read = () => {};
		bodytext_stream.push(rfc_822_node.bodytext);
		bodytext_stream.push(null);
		bodytext_stream.pipe(splitter);

	};

	function getFirstNodeOfType(haraka_obj, type = 'text/html', depth = 0, index = 0) {

		if (haraka_obj.ct && haraka_obj.ct.includes(type)) { return haraka_obj; }

		const num_children = haraka_obj.children.length;

		var matching_child_node = null;
		var i = 0;
		// take first node that matches the requested message-type
		while (! matching_child_node && i < num_children) {
			matching_child_node = getFirstNodeOfType(haraka_obj.children[i++], type, depth+1, ++index);
		}

		return matching_child_node || null;
	};


	////////////////// Init Linkify ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

	/// init linkify ///
	linkify.tlds(require('tlds'))
		.add('ftp:', null) // Disable `ftp:` ptotocol
		.set({ fuzzyIP: true, fuzzyLink: true, fuzzyEmail: true });

	// convert twitter handles
	linkify.add('@', {
		validate: function (text, pos, self) {
			var tail = text.slice(pos);

			if (!self.re.twitter) {
				self.re.twitter =  new RegExp('^([a-zA-Z0-9_]){1,15}(?!_)(?=$|' + self.re.src_ZPCc + ')');
			}

			if (self.re.twitter.test(tail)) {
				// Linkifier allows punctuation chars before prefix,
				// but we additionally disable `@` ("@@mention" is invalid)
				if (pos >= 2 && tail[pos - 2] === '@') { return false; }
				return tail.match(self.re.twitter)[0].length;
			}

			return 0;
		},
		normalize: function (match) {
			match.url = 'https://twitter.com/' + match.url.replace(/^@/, '');
		}
	});


	// exposed members
	return {
		getHtmlAndTextBody : _getHtmlAndTextBody, // (email_obj, body, callback)
		convertPlainTextToHtml : _convertPlainTextToHtml // (text)
	};
}();
module.exports = EmailBodyUtility;

# frozen_string_literal: true

require 'js'
require 'json'
require 'raindown/endpoint/curl'
require 'raindown/js/js_nodes'

# What Raindown can't do in WebAssembly, which has no processes, it asks of the plugin's worker, src/worker.js, and
# waits for, as RaindownEngine.answer runs in evalAsync: an endpoint's request, which Obsidian sends with requestUrl,
# a project's JavaScript Components, which run in the worker, rather than QuickJS, and Raindown's services for its Ruby
# nodes, which the worker answers as it does for JavaScript ones. Only the worker loads this.
module RaindownWorker
  # Raindown::Curl's fetcher: the request's response, as Obsidian received it.
  def self.fetch(request)
    response = JSON.parse(JS.global.call(:raindownFetch, JSON.generate(request.to_h)).await.to_s, symbolize_names: true)
    raise Raindown::Curl::Error, response[:error] if response[:error]

    Raindown::Curl::Response.received(**response.slice(:body, :content_type, :status, :milliseconds))
  end

  # Raindown::Services' host: a service's answer, from the worker, as Ruby can't open sockets or run git here.
  module Services
    def self.call(root, name, args)
      reply = JSON.parse(JS.global.call(:raindownService, root, name, JSON.generate(args)).await.to_s)
      raise Raindown::Services::Error, reply['error'] if reply.key?('error')

      reply['value']
    end
  end

  # The JavaScript Components' host, answering as Raindown's QuickJS one does.
  class Components
    def request(**message)
      reply = JSON.parse(JS.global.call(:raindownComponents, JSON.generate(message)).await.to_s)
      raise Raindown::JSNodes::Error, reply['error'] if reply['error']

      reply
    end
  end
end

Raindown::Curl.fetcher = RaindownWorker.method(:fetch)
Raindown::JSNodes.host = RaindownWorker::Components.new
Raindown::Services.host = RaindownWorker::Services

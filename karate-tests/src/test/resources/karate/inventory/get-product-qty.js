function fn(args) {
  var result = karate.call('classpath:karate/inventory/get-product.feature', { id: args.id });
  return { qty: result.response.quantity };
}

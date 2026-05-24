package com.sentinel.inventory.service;

import com.sentinel.inventory.model.Product;
import com.sentinel.inventory.repository.ProductRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import java.util.List;
import java.util.Optional;

@Service
@RequiredArgsConstructor
public class ProductService {

    private final ProductRepository productRepository;

    public List<Product> getAllProducts() {
        return productRepository.findAll();
    }

    public Optional<Product> getProductById(Long id) {
        return productRepository.findById(id);
    }

    public Optional<Product> getProductBySku(String sku) {
        return productRepository.findBySku(sku);
    }

    public List<Product> getProductsByCategory(String category) {
        return productRepository.findByCategory(category);
    }

    public List<Product> searchProducts(String name) {
        return productRepository.findByNameContainingIgnoreCase(name);
    }

    public Product createProduct(Product product) {
        if (productRepository.findBySku(product.getSku()).isPresent()) {
            throw new IllegalArgumentException("Product with SKU " + product.getSku() + " already exists");
        }
        return productRepository.save(product);
    }

    public Product updateProduct(Long id, Product updated) {
        return productRepository.findById(id).map(existing -> {
            existing.setName(updated.getName());
            existing.setPrice(updated.getPrice());
            existing.setQuantity(updated.getQuantity());
            existing.setCategory(updated.getCategory());
            existing.setDescription(updated.getDescription());
            existing.setActive(updated.getActive());
            return productRepository.save(existing);
        }).orElseThrow(() -> new RuntimeException("Product not found with id: " + id));
    }

    public void updateStock(Long id, int delta) {
        productRepository.findById(id).map(p -> {
            int newQty = p.getQuantity() + delta;
            if (newQty < 0) throw new IllegalStateException("Insufficient stock for product id: " + id);
            p.setQuantity(newQty);
            return productRepository.save(p);
        }).orElseThrow(() -> new RuntimeException("Product not found with id: " + id));
    }

    public void deleteProduct(Long id) {
        productRepository.findById(id).ifPresentOrElse(
            p -> { p.setActive(false); productRepository.save(p); },
            () -> { throw new RuntimeException("Product not found with id: " + id); }
        );
    }
}
